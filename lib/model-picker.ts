import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";

/** Bounded, searchable list for potentially large provider/model catalogues. */
export function pickModel(ctx: ExtensionContext, items: SelectItem[]) {
  return ctx.ui.custom<string | undefined>((tui, theme, kb, done) => {
    const input = new Input();
    const listTheme = {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    };
    let list: SelectList;
    const container = new Container();
    function rebuild() {
      const terms = input.getValue().toLowerCase().split(/\s+/).filter(Boolean);
      list = new SelectList(items.filter(item => terms.every(term =>
        `${item.label} ${item.description ?? ""}`.toLowerCase().includes(term))), 8, listTheme);
      list.onSelect = item => done(item.value);
      list.onCancel = () => done(undefined);
      container.clear();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text("Choose model — type to filter", 1, 0));
      container.addChild(input);
      container.addChild(list);
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    }
    rebuild();
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput(data: string) {
        if (kb.matches(data, "tui.select.cancel")) done(undefined);
        else if (kb.matches(data, "tui.select.confirm")) {
          const selected = list.getSelectedItem();
          if (selected) done(selected.value);
        } else if ((["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const)
          .some(key => kb.matches(data, key))) list.handleInput(data);
        else {
          input.handleInput(data);
          rebuild();
        }
        tui.requestRender();
      },
    };
  });
}
