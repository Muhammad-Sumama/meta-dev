import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectsPanel } from "@/components/editor/ObjectsPanel";
import { ToolOptions } from "@/components/editor/ToolOptions";
import { ToolRail } from "@/components/editor/ToolRail";
import { useEditor } from "@/stores/editor";
import { makeProject, makeTrack, renderInEditor } from "./helpers";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn(), message: vi.fn() }) }));

describe("tools and objects", () => {
  beforeEach(() => {
    useEditor.getState().init(makeProject(), [makeTrack("trk_aaaaaaaaaaaa", [0, 1, 2])], []);
  });

  it("switches tools and shows shortcut hints", async () => {
    renderInEditor(<ToolRail />);
    const brush = screen.getByRole("radio", { name: "Brush tool (B)" });
    await userEvent.click(brush);
    expect(useEditor.getState().tool).toBe("brush");
    expect(brush).toHaveAttribute("aria-checked", "true");
  });

  it("makes the edit scope explicit for brush editing", async () => {
    useEditor.getState().setTool("brush");
    renderInEditor(<ToolOptions />);
    expect(screen.getByRole("slider", { name: "Brush size" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Whole sequence" }));
    expect(useEditor.getState().editScope).toBe("sequence");
  });

  it("lists objects and supports rename, hide and new objects", async () => {
    renderInEditor(<ObjectsPanel />);
    expect(screen.getByText("3 fr")).toBeInTheDocument();
    await userEvent.dblClick(screen.getByRole("button", { name: "Red car" }));
    const input = screen.getByRole("textbox", { name: "Object name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Hero car{Enter}");
    expect(useEditor.getState().doc.tracks.trk_aaaaaaaaaaaa.name).toBe("Hero car");
    await userEvent.click(screen.getByRole("button", { name: "Hide Hero car" }));
    expect(useEditor.getState().doc.tracks.trk_aaaaaaaaaaaa.visible).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "New object" }));
    expect(useEditor.getState().doc.order).toHaveLength(2);
    expect(useEditor.getState().tool).toBe("select");
  });
});
