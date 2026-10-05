import Link from "next/link";
import {
  ArrowRight,
  Braces,
  Crosshair,
  Globe,
  Layers,
  MessageSquareText,
  ScanLine,
  Sparkles,
  Upload,
  Download,
  Cpu,
} from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { DemoButton } from "@/components/landing/DemoButton";
import { HeroPreview } from "@/components/landing/HeroPreview";
import { Button } from "@/components/ui/button";

const FEATURES = [
  {
    icon: Crosshair,
    title: "AI object isolation",
    body: "Select people, animals, vehicles, products and other objects with a click, a rough box, or a sentence.",
  },
  {
    icon: MessageSquareText,
    title: "Natural language editing",
    body: "Tell the AI what you want — “blur the background behind the dog” — instead of drawing masks frame by frame.",
  },
  {
    icon: ScanLine,
    title: "Intelligent tracking",
    body: "Masks follow the object as it moves through the shot. Correct a frame and re-track from there.",
  },
  {
    icon: Globe,
    title: "Browser-based",
    body: "The core workflow runs in a browser tab: upload, select, refine, preview and export. No heavyweight software required.",
  },
  {
    icon: Cpu,
    title: "Powered by open AI models",
    body: "Built around open models including SAM 3 and SAM 2 for segmentation and Llama for understanding requests.",
  },
  {
    icon: Layers,
    title: "Production-ready outputs",
    body: "Export transparent WebM or ProRes 4444, PNG sequences, black-and-white mattes, or the project as JSON.",
  },
];

const STEPS = [
  { icon: Upload, title: "Upload", body: "Drop in an MP4, MOV or WebM. OpenSAM reads the metadata and builds a timeline." },
  { icon: Sparkles, title: "Describe", body: "Say what to isolate. The request becomes a validated command, then masks tracked across every frame." },
  { icon: Download, title: "Export", body: "Preview the effect live, refine with brush and eraser, and export a matte, cutout or finished video." },
];

const COMMAND_JSON = `{
  "action": "track",
  "target": {
    "type": "vehicle",
    "description": "red car",
    "attributes": { "colors": ["red"] }
  },
  "tracking": true,
  "output": "mask"
}`;

export default function LandingPage() {
  return (
    <div className="min-h-dvh overflow-x-hidden">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur-md">
        <nav className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6" aria-label="Main">
          <Link href="/" className="flex items-center gap-2">
            <Logo className="size-7" />
            <span className="text-[15px] font-semibold tracking-tight">OpenSAM Studio</span>
          </Link>
          <div className="hidden items-center gap-5 text-[13.5px] text-muted md:flex">
            <a href="#features" className="hover:text-foreground">
              Features
            </a>
            <a href="#how" className="hover:text-foreground">
              How it works
            </a>
            <a href="#models" className="hover:text-foreground">
              Models
            </a>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button asChild size="sm" variant="ghost" className="hidden sm:inline-flex">
              <Link href="/editor">Projects</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/editor">
                Start Creating <ArrowRight />
              </Link>
            </Button>
          </div>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="relative border-b border-border">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:linear-gradient(to_right,#1a1d23_1px,transparent_1px),linear-gradient(to_bottom,#1a1d23_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_75%)]"
          />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-14 sm:px-6 lg:grid-cols-[1fr_1.1fr] lg:pb-24 lg:pt-20">
            <div>
              <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-border-strong bg-panel px-3 py-1 text-[12px] text-muted">
                <span className="size-1.5 rounded-full bg-accent" /> AI video masking &amp; rotoscoping
              </p>
              <h1 className="text-[44px] font-semibold leading-[1.02] tracking-[-0.035em] sm:text-6xl">
                OpenSAM Studio
                <span className="mt-2 block text-muted">Rotoscoping, powered by AI.</span>
              </h1>
              <p className="mt-6 max-w-lg text-[17px] leading-relaxed text-muted">
                Upload a video. Tell AI what you want to isolate. OpenSAM Studio tracks it for you.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Button asChild size="lg">
                  <Link href="/editor">
                    Start Creating <ArrowRight />
                  </Link>
                </Button>
                <DemoButton size="lg" variant="secondary">
                  Try Demo
                </DemoButton>
              </div>
              <p className="mt-5 text-[12.5px] text-faint">Runs locally. No account, no API keys needed for the demo.</p>
            </div>
            <HeroPreview />
          </div>
        </section>

        {/* Features */}
        <section id="features" className="scroll-mt-16 border-b border-border">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <h2 className="max-w-xl text-3xl font-semibold tracking-tight">From “select the dog” to a clean matte, without drawing a single mask.</h2>
            <div className="mt-12 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <div key={f.title} className="bg-background p-6">
                  <f.icon className="size-5 text-accent" strokeWidth={1.8} />
                  <h3 className="mt-4 text-[15px] font-semibold">{f.title}</h3>
                  <p className="mt-2 text-[14px] leading-relaxed text-muted">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="scroll-mt-16 border-b border-border">
          <div className="mx-auto grid max-w-6xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight">How it works</h2>
              <ol className="mt-8 flex flex-col gap-6">
                {STEPS.map((s, i) => (
                  <li key={s.title} className="flex gap-4">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border-strong bg-panel font-mono text-[13px] text-muted">
                      {i + 1}
                    </span>
                    <div>
                      <h3 className="flex items-center gap-2 text-[15px] font-semibold">
                        <s.icon className="size-4 text-accent" /> {s.title}
                      </h3>
                      <p className="mt-1 text-[14px] leading-relaxed text-muted">{s.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <div className="flex flex-col gap-3">
              <div className="rounded-lg border border-border-strong bg-panel p-4">
                <p className="text-[12px] font-medium text-muted">What do you want to isolate?</p>
                <p className="mt-2 rounded-md border border-border bg-panel-2 px-3 py-2 text-[14px]">Track the red car.</p>
              </div>
              <div className="flex items-center gap-2 pl-4 text-[12px] text-faint">
                <Braces className="size-3.5" /> Llama → validated command
              </div>
              <pre className="overflow-x-auto rounded-lg border border-border bg-panel p-4 font-mono text-[12.5px] leading-relaxed text-muted">{COMMAND_JSON}</pre>
              <div className="flex items-center gap-2 pl-4 text-[12px] text-faint">
                <ScanLine className="size-3.5" /> SAM 3 → masks on every frame → FFmpeg export
              </div>
            </div>
          </div>
        </section>

        {/* Models */}
        <section id="models" className="scroll-mt-16 border-b border-border">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr]">
              <div>
                <h2 className="text-3xl font-semibold tracking-tight">Built around open AI models</h2>
                <p className="mt-4 text-[15px] leading-relaxed text-muted">
                  OpenSAM Studio is an independent creative tool built around open AI technologies, including SAM 3, SAM 2 and Llama. Model
                  providers sit behind a clean interface, so the same editor runs on a laptop or talks to GPU servers.
                </p>
              </div>
              <dl className="grid gap-4 sm:grid-cols-2">
                {[
                  ["SAM 3 / SAM 2", "Promptable video segmentation: text, points, boxes and masks in, tracked masks out."],
                  ["Llama", "Turns natural-language requests into structured, schema-validated editing commands."],
                  ["Mock mode", "A classical computer-vision fallback so the whole workflow works without a GPU — clearly labeled in the app."],
                  ["FFmpeg", "Decoding, thumbnails, transparent video, PNG sequences and matte exports."],
                ].map(([t, d]) => (
                  <div key={t} className="rounded-lg border border-border bg-panel p-4">
                    <dt className="text-[14px] font-semibold">{t}</dt>
                    <dd className="mt-1.5 text-[13.5px] leading-relaxed text-muted">{d}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section>
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-20 sm:px-6 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight">Isolate your first shot in a minute.</h2>
              <p className="mt-2 text-[15px] text-muted">Open the demo clip, or bring your own footage.</p>
            </div>
            <div className="flex gap-3">
              <DemoButton size="lg" variant="secondary">
                Try Demo
              </DemoButton>
              <Button asChild size="lg">
                <Link href="/editor">
                  Start Creating <ArrowRight />
                </Link>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-[12.5px] leading-relaxed text-faint sm:px-6">
          <div className="flex items-center gap-2 text-muted">
            <Logo className="size-5" /> OpenSAM Studio
          </div>
          <p>
            OpenSAM Studio is an independent project. It is not affiliated with, endorsed by, or sponsored by Meta Platforms, Inc. SAM 3, SAM 2 and Llama are
            models released by Meta under their respective licenses; OpenSAM Studio is built to work with them.
          </p>
        </div>
      </footer>
    </div>
  );
}
