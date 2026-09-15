// Query-only policy. No store access, model calls, or mutable conversation state.
const stopwords = new Set("a an and are as at be been being but by can could did do does doing for from had has have having how i if in into is it its me my of on or our please should so that the their them then there these they this to until us was we were what when where which who will with would you your not no yes cannot".split(" "));
const conversational = new Set("about actually actual after again ahead all also always any anything aren around before better both change changes couple describe doesn else even everything explain fine first get gets getting give go going good great here isn just kind know let lets like lol look looking lot many maybe more most much need needs new next now often okay only really right same say see show showing some something still sure take tell than thing things think thinking those through too usually very want wants way well whether why won work working yet".split(" "));

// These words can support a named topic, but cannot establish one by themselves.
const generic = new Set("result results match matches turn turns removed updated added changed run runs local small large bad long short".split(" "));
export const isTopicTerm = (term: string) => !generic.has(term);

/** Unicode words with combining marks removed like unicode61's usual Latin folding.
 * Strip contraction suffixes before tokenization; never turn I'm/aren't into m/t.
 * Keep short technical names (Pi, VR, C) except conversational single-letter debris.
 */
export function queryTerms(query: string, automatic = false): string[] {
  const text = query.slice(0, 4096).toLowerCase()
    .replace(/\p{Script=Latin}\p{M}*/gu, letter => letter.normalize("NFD").replace(/\p{M}/gu, ""))
    .replace(/[’']/g, "'").replace(/\bcan't\b/g, "cannot").replace(/\bwon't\b/g, "will")
    .replace(/\b([a-z]+)n't\b/g, "$1")
    .replace(/\b([a-z]+)'(?:s|m|re|ve|ll|d)\b/g, "$1");
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
  const terms = [...new Set(words.filter(t => t.length <= 64 && !stopwords.has(t) &&
    !["m", "s", "t", "d", "ll", "re", "ve"].includes(t) && (!automatic || !conversational.has(t))))];
  // Sample across the entire bounded prompt instead of discarding its latter topic.
  return terms.length <= 32 ? terms : Array.from({ length: 32 }, (_, i) => terms[Math.floor(i * (terms.length - 1) / 31)]);
}

/** A topic hint is not a second query: it may support a current-word match only.
 * One preceding user prompt, no assistant/tool/recall text or recursive topic state.
 */
export function followupTerms(query: string, previousPrompt?: string): string[] {
  const primary = queryTerms(query, true);
  if (!previousPrompt || !primary.some(isTopicTerm) || primary.length > 8 ||
      !/\b(it|its|those|these|that|they|them|same|again)\b/i.test(query.slice(0, 4096)) ||
      /\b(unrelated|instead|different topic|switch(?:ing)? (?:topics?|to)|new (?:topic|question))\b/i.test(query)) return [];
  return queryTerms(previousPrompt.slice(0, 1024), true).filter(t => isTopicTerm(t) && !primary.includes(t)).slice(0, 8);
}
