import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { motion } from "framer-motion";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Cpu,
  Download,
  Flame,
  GitBranch,
  Lock,
  MonitorSmartphone,
  Package,
  Puzzle,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
} from "lucide-react";

const APK_VERSION = "v2.8.5";
// Primary: the GitHub Release asset (permanent, CDN-backed, works everywhere).
// Fallback: the raw file on main. Both serve the same signed v2.8.5 APK.
const APK_FILE =
  "https://github.com/canelaslorenzoenego-ai/dsh-local/releases/latest/download/dsh-local-v2.8.5.apk";
const APK_FALLBACK =
  "https://raw.githubusercontent.com/canelaslorenzoenego-ai/dsh-local/main/public/downloads/dsh-local-v2.8.5.apk";
void APK_FALLBACK;

const fadeUp = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
  transition: { duration: 0.6, ease: "easeOut" as const },
};

const capabilities = [
  {
    icon: Bot,
    title: "Agent console",
    body: "dsh's real presets — Standard, PTC (Code Mode), Minimal, Creator — plus a full custom studio: pick tools, sandbox, model route, save profiles, export JSON.",
  },
  {
    icon: Puzzle,
    title: "Plugins, skills & MCPs",
    body: "Shell exec, file I/O, git, web fetch, swarms, memory MCP, SQLite, test-writer skills — enable/disable and test each one from the console.",
  },
  {
    icon: Terminal,
    title: "Real Termux packages",
    body: "Search and install 1000+ packages from the Termux repos right in the console — and the model installs its own tools with plain `apt install` through its shell.",
  },
  {
    icon: Wrench,
    title: "Built-in terminal",
    body: "Real bash login shell in a xterm.js tab — inside the app or in Chrome. git, python, jq, ripgrep, ssh pre-provisioned into the embedded Linux.",
  },
  {
    icon: Zap,
    title: "OpenAI-compatible gateway",
    body: "Local proxy server on :8787 with /v1/models and streaming /v1/chat/completions — point any client or the agent at it.",
  },
  {
    icon: MonitorSmartphone,
    title: "In-app or Chrome",
    body: "Open the harness UI in a fullscreen in-app view, or fire it into your default browser. Everything binds to localhost loopback.",
  },
  {
    icon: Lock,
    title: "Only you can see it",
    body: "Optional PIN lock at launch, FLAG_SECURE blocks screenshots and recents thumbnails. Keys and state never leave the device.",
  },
];

const specs = [
  { icon: Smartphone, label: "Native Java app", value: "No Electron, no WebView shell" },
  { icon: Package, label: "Embedded Linux", value: "Official Termux bootstrap, no Termux install" },
  { icon: Wrench, label: "Provisioned toolchain", value: "bash · git · python · jq · ripgrep · ssh" },
  { icon: GitBranch, label: "Version", value: `${APK_VERSION} · signed · Android 8.0+ ARM64` },
];

const steps = [
  {
    n: "01",
    title: "Download & sideload",
    body: `Grab the APK below and install it — allow "unknown sources" when Android asks. No root, no Termux, no F-Droid.`,
  },
  {
    n: "02",
    title: "Open — Linux extracts itself",
    body: "First launch unpacks the embedded Linux into app-private storage automatically (~30s, one time). You'll see live progress on the card.",
  },
  {
    n: "03",
    title: "Start the servers",
    body: "Tap Start on the Harness and the Gateway. Two buttons, that's it. Then Open — in-app or in Chrome — and you're in the console.",
  },
];

export default function Landing() {
  return (
    <div className="dark grain relative min-h-screen overflow-x-clip bg-background text-foreground">
      {/* Warm ambient glow */}
      <div
        aria-hidden
        className="ember-glow pointer-events-none absolute inset-x-0 top-0 h-[720px]"
      />

      {/* Nav */}
      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <a href="#" className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/30">
            <Flame className="size-5" />
          </span>
          <span className="font-display text-lg font-bold tracking-tight">DSH Local</span>
        </a>
        <nav className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
          <a href="#features" className="transition-colors hover:text-foreground">
            Features
          </a>
          <a href="#inside" className="transition-colors hover:text-foreground">
            What's inside
          </a>
          <a href="#install" className="transition-colors hover:text-foreground">
            Install
          </a>
        </nav>
        <Button
          asChild
          size="sm"
          className="rounded-lg bg-primary font-semibold shadow-[0_0_24px_-6px_var(--primary)]"
        >
          <a href={APK_FILE} download>
            <Download className="size-4" /> Download
          </a>
        </Button>
      </header>

      {/* Hero */}
      <section className="relative z-10 mx-auto flex w-full max-w-6xl flex-col items-center px-6 pb-24 pt-16 text-center sm:pt-24">
        <motion.div {...fadeUp}>
          <Badge
            variant="outline"
            className="gap-2 border-primary/30 bg-primary/10 px-3.5 py-1.5 text-primary backdrop-blur-sm"
          >
            <span className="animate-breathe inline-block size-1.5 rounded-full bg-primary" />
            {APK_VERSION} · fully standalone · nothing leaves your phone
          </Badge>
        </motion.div>

        <motion.h1
          {...fadeUp}
          transition={{ ...fadeUp.transition, delay: 0.08 }}
          className="font-display mt-7 max-w-4xl text-balance text-5xl font-bold leading-[1.05] sm:text-6xl lg:text-7xl"
        >
          Your own AI coding agent,{" "}
          <span className="ember-text">running on your phone</span>
        </motion.h1>

        <motion.p
          {...fadeUp}
          transition={{ ...fadeUp.transition, delay: 0.16 }}
          className="mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground sm:text-xl"
        >
          DSH Local is one native Android app with a whole datacenter inside: an
          embedded Linux, the DeepSeek Harness with its full agent console, an
          OpenAI-compatible gateway, and a real terminal — all on{" "}
          <code className="font-mono text-primary">localhost</code>, all offline-capable.
        </motion.p>

        <motion.div
          {...fadeUp}
          transition={{ ...fadeUp.transition, delay: 0.24 }}
          className="mt-10 flex flex-col items-center gap-4 sm:flex-row"
        >
          <Button
            asChild
            size="lg"
            className="rounded-lg bg-primary font-semibold shadow-[0_0_32px_-8px_var(--primary)]"
          >
            <a href={APK_FILE} download>
              <Download className="size-5" /> Download APK {APK_VERSION}
            </a>
          </Button>
          <Button asChild size="lg" variant="outline" className="rounded-lg">
            <a href="#install">
              See the install steps <ArrowRight className="size-4" />
            </a>
          </Button>
        </motion.div>
        <motion.p
          {...fadeUp}
          transition={{ ...fadeUp.transition, delay: 0.3 }}
          className="mt-4 flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <ShieldCheck className="size-4 text-primary" />
          ~30 MB · signed · Android 8.0+ · ARM64 · free, no account
        </motion.p>

        {/* Mock phone frame */}
        <motion.div
          {...fadeUp}
          transition={{ ...fadeUp.transition, delay: 0.32 }}
          className="relative mt-20 w-full max-w-5xl"
        >
          <div
            aria-hidden
            className="absolute -inset-x-8 top-8 h-full rounded-[2.5rem] bg-primary/10 blur-3xl"
          />
          <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/70 shadow-2xl backdrop-blur">
            <div className="flex items-center gap-1.5 border-b border-border/60 bg-card/80 px-4 py-3">
              <span className="size-3 rounded-full bg-primary/60" />
              <span className="size-3 rounded-full bg-primary/30" />
              <span className="size-3 rounded-full bg-primary/15" />
              <span className="ml-4 hidden font-mono text-xs text-muted-foreground sm:block">
                dsh-local://dashboard
              </span>
            </div>
            <div className="grid gap-4 p-6 text-left sm:grid-cols-3 sm:p-8">
              {[
                { t: "DeepSeek Harness", s: "Online · 23ms · :3080", on: true, i: Bot },
                { t: "Proxy Gateway", s: "Online · 11ms · :8787", on: true, i: Zap },
                { t: "Terminal", s: "bash · provisioned", on: true, i: Terminal },
              ].map((item) => (
                <div
                  key={item.t}
                  className="rounded-xl border border-border/50 bg-background/60 p-4 transition-colors hover:border-primary/40"
                >
                  <div className="mb-3 flex items-center justify-between">
                    <item.i className="size-5 text-primary" />
                    <span className="flex items-center gap-1.5 text-xs text-primary">
                      <span className="size-1.5 rounded-full bg-primary" />
                      {item.s}
                    </span>
                  </div>
                  <p className="text-sm font-medium">{item.t}</p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    Start / Stop · Open
                  </p>
                </div>
              ))}
              <div className="sm:col-span-3 rounded-xl border border-dashed border-primary/30 bg-primary/5 p-4">
                <div className="flex items-center gap-3">
                  <Sparkles className="size-4 text-primary" />
                  <p className="font-mono text-sm text-muted-foreground">
                    Active preset: Full Power · 16 tools · auto-approve · swarm ×8
                  </p>
                  <span className="ml-auto rounded-md bg-primary/15 px-2 py-0.5 font-mono text-xs text-primary">
                    console
                  </span>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </section>

      {/* Features */}
      <section id="features" className="relative z-10 mx-auto w-full max-w-6xl px-6 py-24">
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <p className="font-mono text-sm uppercase tracking-widest text-primary">
            Why DSH Local
          </p>
          <h2 className="font-display mt-3 text-balance text-3xl font-bold sm:text-4xl">
            A complete agent stack, pocket-sized
          </h2>
          <p className="mt-4 text-muted-foreground">
            Two servers, one terminal, zero cloud dependencies. Your keys, your
            sessions, your device.
          </p>
        </motion.div>

        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {capabilities.map((f, i) => (
            <motion.div
              key={f.title}
              {...fadeUp}
              transition={{ ...fadeUp.transition, delay: i * 0.06 }}
            >
              <Card className="group h-full border-border/60 bg-card/60 backdrop-blur transition-colors hover:border-primary/40">
                <CardContent className="p-7">
                  <div className="mb-5 flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25 transition-shadow group-hover:shadow-[0_0_24px_-6px_var(--primary)]">
                    <f.icon className="size-5" />
                  </div>
                  <h3 className="font-display text-lg font-semibold">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {f.body}
                  </p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </section>

      {/* What's inside */}
      <section id="inside" className="relative z-10 mx-auto w-full max-w-6xl px-6 py-24">
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <p className="font-mono text-sm uppercase tracking-widest text-primary">
            What's inside
          </p>
          <h2 className="font-display mt-3 text-balance text-3xl font-bold sm:text-4xl">
            One APK, zero setup
          </h2>
        </motion.div>

        <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {specs.map((s, i) => (
            <motion.div
              key={s.label}
              {...fadeUp}
              transition={{ ...fadeUp.transition, delay: i * 0.06 }}
              className="rounded-2xl border border-border/60 bg-card/60 p-6 backdrop-blur"
            >
              <s.icon className="size-6 text-primary" />
              <p className="font-display mt-4 font-semibold">{s.label}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {s.value}
              </p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* Install steps */}
      <section id="install" className="relative z-10 mx-auto w-full max-w-6xl px-6 py-24">
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <p className="font-mono text-sm uppercase tracking-widest text-primary">
            Install
          </p>
          <h2 className="font-display mt-3 text-balance text-3xl font-bold sm:text-4xl">
            Three taps from download to agent
          </h2>
        </motion.div>

        <div className="relative mt-14 grid gap-5 md:grid-cols-3">
          <div
            aria-hidden
            className="absolute left-0 right-0 top-8 hidden h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent md:block"
          />
          {steps.map((s, i) => (
            <motion.div
              key={s.n}
              {...fadeUp}
              transition={{ ...fadeUp.transition, delay: i * 0.1 }}
              className="relative rounded-2xl border border-border/60 bg-card/60 p-7 backdrop-blur"
            >
              <div className="flex items-center gap-4">
                <div className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_0_24px_-6px_var(--primary)]">
                  <span className="font-mono text-sm font-bold">{s.n}</span>
                </div>
                {i === 0 && <Cpu className="size-5 text-muted-foreground" />}
              </div>
              <h3 className="font-display mt-5 text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </motion.div>
          ))}
        </div>

        <motion.div
          {...fadeUp}
          className="mx-auto mt-10 flex max-w-2xl flex-col items-start gap-3 rounded-2xl border border-border/60 bg-card/60 p-6 backdrop-blur"
        >
          <p className="text-sm font-medium">Included with the console</p>
          {[
            "Tokenized session links — the console opens only through the link, rotate anytime",
            "4 real dsh presets + a full Custom studio (profiles, import/export)",
            "13 plugins, 9 skills, 8 MCPs, 8 integrations, plus a real apt-backed Termux package system — the model installs its own tools (98-check test suite)",
            "Tool search and detail sheets for every capability",
            "PIN privacy, in-app or Chrome opening, foreground-service keepalive",
          ].map((li) => (
            <p key={li} className="flex items-start gap-2.5 text-sm text-muted-foreground">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
              {li}
            </p>
          ))}
        </motion.div>
      </section>

      {/* Download CTA */}
      <section className="relative z-10 mx-auto w-full max-w-6xl px-6 pb-8">
        <motion.div
          {...fadeUp}
          className="flex flex-col items-start gap-6 rounded-3xl border border-primary/25 bg-gradient-to-b from-primary/15 via-card/60 to-card/60 p-8 backdrop-blur sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary ring-1 ring-primary/25">
              <Smartphone className="size-6" />
            </div>
            <div>
              <h3 className="font-display text-lg font-semibold">
                DSH Local {APK_VERSION} — Android
              </h3>
              <p className="mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
                Embedded Linux · DeepSeek Harness console · OpenAI-compatible
                gateway · real terminal · tokenized session links · 30+ agent
                tools. Everything runs on 127.0.0.1, nothing runs in the cloud.
              </p>
              <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="size-3.5 text-primary" />
                {APK_VERSION} · ~30 MB · signed · Android 8.0+ ARM64
              </p>
            </div>
          </div>
          <Button
            asChild
            size="lg"
            className="shrink-0 rounded-lg bg-primary font-semibold shadow-[0_0_24px_-6px_var(--primary)]"
          >
            <a href={APK_FILE} download>
              <Download className="size-5" /> Download APK
            </a>
          </Button>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border/60">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <Flame className="size-4 text-primary" />
            <span>© {new Date().getFullYear()} DSH Local</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="#features" className="transition-colors hover:text-foreground">
              Features
            </a>
            <a href="#inside" className="transition-colors hover:text-foreground">
              What's inside
            </a>
            <a href="#install" className="transition-colors hover:text-foreground">
              Install
            </a>
            <a href={APK_FILE} download className="transition-colors hover:text-foreground">
              Download
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
