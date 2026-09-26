import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AIPanel } from "@/components/ai/AIPanel";
import { useEditor } from "@/stores/editor";
import { jsonResponse, makeProject, renderInEditor } from "./helpers";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), warning: vi.fn(), success: vi.fn(), message: vi.fn() }) }));

const record = (over: Record<string, unknown> = {}) => ({
  id: "cmd_aaaaaaaaaaaa",
  text: "Track the red car",
  createdAt: new Date().toISOString(),
  command: { version: 1, action: "track", intent: "segment_and_track", target: { type: "vehicle", description: "red car", attributes: { colors: ["red"], clothing: [] }, reference: "description" }, tracking: true, effect: { type: "none" }, output: "mask", frameRange: null, confidence: 0.9 },
  source: "rules",
  planSummary: "Find “red car” and segment it, track it through the whole clip.",
  status: "running",
  jobId: "job_aaaaaaaaaaaa",
  warnings: [],
  ...over,
});

const job = { id: "job_aaaaaaaaaaaa", type: "segment", projectId: "prj_aaaaaaaaaaaa", label: "Track the red car", status: "processing", progress: { stage: "tracking", message: "Tracking frame 12 / 300", current: 12, total: 300, fraction: 0.3 }, input: {}, createdAt: "" };

describe("AIPanel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    useEditor.getState().init(makeProject(), [], []);
    useEditor.getState().setCurrentFrame(42);
    fetchMock = vi.fn(async () => jsonResponse({ record: record(), parsed: { command: record().command, source: "rules", warnings: [], model: "rules-v1", latencyMs: 1 }, plan: { steps: [], requiresSegmentation: true, summary: "" }, job }, 202));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("submits the command with the current frame and shows pipeline progress", async () => {
    renderInEditor(<AIPanel onOpenExport={vi.fn()} />);
    const input = screen.getByLabelText("What do you want to isolate?");
    await userEvent.type(input, "Track the red car{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/prj_aaaaaaaaaaaa/commands");
    expect(JSON.parse(String(init.body))).toEqual({ text: "Track the red car", frameIndex: 42 });
    expect(await screen.findByText("Track through video")).toBeInTheDocument();
    expect(screen.getByText("12/300")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("runs a suggestion with one click and lists it in history", async () => {
    renderInEditor(<AIPanel onOpenExport={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Track the red car" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Show structured command")).toBeInTheDocument();
    expect(screen.getByText("Built-in parser")).toBeInTheDocument();
  });

  it("shows plain-language errors with a hint", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: "TARGET_NOT_FOUND", message: "We couldn't find “unicorn” in this video.", hint: "Try clicking the object with the Select tool instead.", retryable: false } }, 422),
    );
    renderInEditor(<AIPanel onOpenExport={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("What do you want to isolate?"), "Track the unicorn{Enter}");
    expect(await screen.findByText("We couldn't find “unicorn” in this video.")).toBeInTheDocument();
    expect(screen.getByText(/Select tool instead/)).toBeInTheDocument();
  });

  it("does not submit empty commands", async () => {
    renderInEditor(<AIPanel onOpenExport={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("What do you want to isolate?"), "   {Enter}");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Run command" })).toBeDisabled();
  });
});
