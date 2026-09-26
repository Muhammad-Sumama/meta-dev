import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploadDropzone } from "@/components/video/UploadDropzone";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

/** Minimal XMLHttpRequest double that reports upload progress. */
class FakeXHR {
  static last: FakeXHR | null = null;
  static respond: { status: number; body: unknown } = { status: 201, body: {} };
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  response: unknown = null;
  responseType = "";
  headers: Record<string, string> = {};
  url = "";
  sent: unknown;
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: unknown) {
    this.sent = body;
    FakeXHR.last = this;
  }
  abort() {
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  finish() {
    this.status = FakeXHR.respond.status;
    this.response = FakeXHR.respond.body;
    this.onload?.();
  }
}

describe("UploadDropzone", () => {
  beforeEach(() => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    push.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("rejects unsupported files before uploading", async () => {
    render(<UploadDropzone maxUploadMb={10} />);
    const input = screen.getByLabelText("Choose a video file");
    await userEvent.upload(input, new File(["hello"], "notes.txt", { type: "text/plain" }), { applyAccept: false });
    expect(await screen.findByRole("alert")).toHaveTextContent(/aren't supported/);
    expect(FakeXHR.last?.url).not.toBe("/api/projects");
  });

  it("rejects files over the size limit", async () => {
    render(<UploadDropzone maxUploadMb={1} />);
    const big = new File([new Uint8Array(2 * 1024 * 1024)], "big.mp4", { type: "video/mp4" });
    fireEvent.drop(screen.getByText("Drop a video here").closest("div")!, { dataTransfer: { files: [big] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/limit is 1 MB/);
  });

  it("shows progress, then opens the new project", async () => {
    FakeXHR.respond = { status: 201, body: { project: { id: "prj_bbbbbbbbbbbb" }, job: { id: "job_x" } } };
    render(<UploadDropzone maxUploadMb={10} />);
    await userEvent.upload(screen.getByLabelText("Choose a video file"), new File([new Uint8Array(1000)], "clip.mp4", { type: "video/mp4" }));
    const xhr = FakeXHR.last!;
    expect(xhr.url).toBe("/api/projects");
    expect(xhr.headers["x-file-name"]).toBe("clip.mp4");
    xhr.progress(500, 1000);
    expect(await screen.findByText(/Uploading… 50%/)).toBeInTheDocument();
    xhr.progress(1000, 1000);
    expect(await screen.findByText(/Validating video/)).toBeInTheDocument();
    xhr.finish();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/editor/prj_bbbbbbbbbbbb"));
  });

  it("shows the server's plain-language error", async () => {
    FakeXHR.respond = {
      status: 422,
      body: { error: { code: "CORRUPTED_VIDEO", message: "We couldn't read this video.", hint: "Try re-exporting it as H.264 MP4.", retryable: false } },
    };
    render(<UploadDropzone maxUploadMb={10} />);
    await userEvent.upload(screen.getByLabelText("Choose a video file"), new File([new Uint8Array(10)], "bad.mp4", { type: "video/mp4" }));
    FakeXHR.last!.finish();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We couldn't read this video.");
    expect(alert).toHaveTextContent("Try re-exporting it as H.264 MP4.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
