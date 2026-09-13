import { createHash } from "node:crypto";

// Hand-curated, dependency-free v1 vocabulary: 256 distinct ASCII words, four
// independent bytes => 32 bits / 4,294,967,296 handles. Not credentials.
// Identity contract: NEVER reorder/edit this list or change the derivation for
// existing IDs. A future vocabulary needs an explicitly persisted version.
export const HANDLE_WORDS: readonly string[] = Object.freeze(`
acorn alder amber anchor apple apron arch arrow ash atlas autumn badge bamboo bark barn basin
bay beach bead beam bear beech bell berry birch bird bloom boat bolt book booth bowl
branch brass bread breeze brick bridge brook brush bud buffalo bug cabin cactus cake camel camp
candle canoe cape carp carrot cart cave cedar cello chalk charm cherry chess chest chime clay
cliff cloak cloud clover coast cobra cocoa comet compass coral cork corn crane creek crest cricket
crow crown crystal cub cup cypress daisy dawn deer delta den dew dock dog dolphin dove
dragon drift drum duck dune eagle earth echo eel elm ember falcon fan fawn feather fern
field fig finch fir fire fish flag flame flax flint flock flute foam fog forest fork
fox frost garden gate gem ginger glass globe glow goat gold goose grain grape grass grove
gull harbor hare harp harvest hawk hazel heart heath hedge heron hill hive holly honey horn
horse hound ice ink iris island ivory ivy jade jar jasmine jay jewel juniper kelp key
kite kiwi koala lace lake lamb lamp larch lark leaf lemon leopard lily lime linen lion
lotus lynx maple marble marsh meadow melon mesa mint mist moon moose moss moth mouse mule
nest nettle newt night oak oasis ocean olive onyx opal orchid otter owl palm panda paper
peach pearl pebble pine plum pond poppy quail quartz quilt rain raven reed reef river robin
rock rose ruby sage sand seal shell shore silk slate snow sparrow spruce star stone willow
`.trim().split(/\s+/));

/** Stable across labels, reconnects and daemon restarts; existing DBs need no migration. */
export function participantHandle(id: string): string {
  const bytes = createHash("sha256").update(`switchboard-handle-v1:${id}`).digest();
  return [...bytes.subarray(0, 4)].map(byte => HANDLE_WORDS[byte]!).join("-");
}
