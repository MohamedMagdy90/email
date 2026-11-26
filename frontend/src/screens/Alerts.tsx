// Alerts on your phone and computer: the bell in the brand bar and its dialog.
// This device (turn on / test / off, or how to get there on an iPhone), the
// three kinds of reply that alert, every signed-up device, recent alerts.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Badge, Button, Modal, Spinner, cn, toast } from "../lib/ui";
import { ago } from "../lib/v2/core";
import { openThread } from "./campaigns/parts";
import {
  INSTALLABLE_EVENT,
  canInstall,
  deviceLabel,
  deviceState,
  isIos,
  promptInstall,
  pushApi,
  turnOff,
  turnOn,
  type DeviceState,
  type PushPrefs,
  type PushView,
} from "../lib/v2/push";

const KINDS: { id: keyof PushPrefs; title: string; body: string }[] = [
  {
    id: "handoff",
    title: "Replies handed to you",
    body: "Kinds you keep for yourself, unclear replies, legal requests, replies the agent isn't sure about, and anything it couldn't write or send.",
  },
  {
    id: "interested",
    title: "Interested leads",
    body: "They want a call, a demo or the next step, even when the agent answers on its own.",
  },
  {
    id: "drafts",
    title: "Replies waiting for your approval",
    body: "The agent wrote an answer and holds it for you to send.",
  },
];

const STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  held: { label: "Grouping", cls: "bg-wnb text-warn" },
  grouped: { label: "Sent as one", cls: "bg-ink/[0.06] text-muted" },
  no_device: { label: "No device", cls: "bg-ink/[0.06] text-muted" },
  failed: { label: "Not delivered", cls: "bg-dgb text-bad" },
  dropped: { label: "Dealt with", cls: "bg-ink/[0.06] text-muted" },
  sending: { label: "Sending", cls: "bg-inb text-inf" },
};

const Label = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn("text-[11px] font-semibold uppercase tracking-[0.09em] text-muted", className)}>{children}</div>
);

function Bell({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

/** The bell in the brand bar. A dot = alerts are on for this device. */
export function AlertsButton() {
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (open) return;
    deviceState()
      .then((s) => setOn(s.kind === "on"))
      .catch(() => setOn(false));
  }, [open]);
  return (
    <>
      <button
        type="button"
        className="thm relative"
        onClick={() => setOpen(true)}
        title={on ? "Alerts are on for this device" : "Alerts on your phone and computer"}
        aria-label="Alerts"
      >
        <Bell />
        {on && <span className="absolute right-[5px] top-[5px] h-[7px] w-[7px] rounded-full bg-brand ring-2 ring-[var(--bar)]" />}
      </button>
      {/* Portalled: the brand bar's backdrop-filter would trap a fixed dialog inside the bar. */}
      {open && createPortal(<AlertsDialog onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function AlertsDialog({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<PushView | null>(null);
  const [state, setState] = useState<DeviceState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "on" | "off" | "test" | "install" | string>("");
  const [installable, setInstallable] = useState(canInstall);

  const refresh = useCallback(async (v?: PushView) => {
    const next = v || (await pushApi.view());
    setView(next);
    setState(await deviceState(next.devices.map((d) => d.endpoint)));
  }, []);

  useEffect(() => {
    refresh().catch((e) => setError(e.message || "Couldn't load the alerts."));
    const h = () => setInstallable(canInstall());
    window.addEventListener(INSTALLABLE_EVENT, h);
    return () => window.removeEventListener(INSTALLABLE_EVENT, h);
  }, [refresh]);

  function enable() {
    if (!view) return;
    setBusy("on");
    // No await before turnOn: iPhones only ask for permission on a direct tap.
    turnOn(view.publicKey)
      .then(async (v) => {
        await refresh(v);
        toast("Alerts are on for this device.", "success");
      })
      .catch((e) => toast(e.message, "error"))
      .finally(() => setBusy(""));
  }

  async function disable() {
    setBusy("off");
    try {
      await refresh((await turnOff()) || undefined);
      toast("Alerts are off for this device.", "info");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy("");
    }
  }

  async function test() {
    if (state?.kind !== "on") return;
    setBusy("test");
    try {
      const r = await pushApi.test(state.endpoint);
      await refresh(r.view);
      if (r.result.delivered) toast("Test sent. It should appear in a few seconds.", "success");
      else toast(r.result.errors[0] || "The push service didn't take the test.", "error");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy("");
    }
  }

  async function savePref(id: keyof PushPrefs, value: boolean) {
    if (!view) return;
    setView({ ...view, prefs: { ...view.prefs, [id]: value } });
    try {
      setView((await pushApi.savePrefs({ [id]: value })).view);
    } catch (e: any) {
      toast(e.message, "error");
      refresh().catch(() => {});
    }
  }

  async function remove(id: string) {
    setBusy(`rm:${id}`);
    try {
      await refresh((await pushApi.removeDevice(id)).view);
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy("");
    }
  }

  async function install() {
    setBusy("install");
    try {
      if (await promptInstall()) toast("Installed. Open it from your apps, sign in, and turn alerts on there too.", "success");
    } finally {
      setBusy("");
      setInstallable(canInstall());
    }
  }

  const thisEndpoint = state?.kind === "on" ? state.endpoint : null;

  return (
    <Modal open onClose={onClose} title="Alerts on your phone and computer" wide>
      <p className="-mt-1 mb-5 max-w-[640px] text-[13px] leading-relaxed text-muted">
        When a reply needs you, your devices show an alert, even with the app closed. Tapping it opens the conversation.
      </p>
      {!view || !state ? (
        error ? (
          <p className="py-6 text-center text-sm text-bad">{error}</p>
        ) : (
          <div className="flex items-center gap-2 py-10 text-muted">
            <Spinner /> Loading…
          </div>
        )
      ) : (
        <div className="space-y-5">
          <ThisDevice state={state} busy={busy} onEnable={enable} onDisable={disable} onTest={test} installable={installable} onInstall={install} />

          <section>
            <Label className="mb-2.5">What alerts you</Label>
            <div className="divide-y divide-line-soft rounded-xl border border-line-soft">
              {KINDS.map((k) => (
                <label key={k.id} className="flex cursor-pointer items-start gap-3 px-4 py-3">
                  <Switch checked={view.prefs[k.id]} onChange={(v) => savePref(k.id, v)} label={k.title} />
                  <span className="min-w-0">
                    <span className="block text-[13.5px] font-semibold">{k.title}</span>
                    <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{k.body}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              Never: out-of-office replies, bounces, unsubscribes, or replies the agent sends by itself. Replies more than a day old don't alert, and
              more than 5 in 10 minutes arrive as one alert. These switches apply to every device.
            </p>
          </section>

          <section>
            <Label className="mb-2.5">Devices</Label>
            {view.devices.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line px-4 py-5 text-center text-[12.5px] text-muted">No device gets alerts yet.</div>
            ) : (
              <ul className="divide-y divide-line-soft rounded-xl border border-line-soft">
                {view.devices.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13.5px] font-semibold">{d.label}</span>
                        {d.endpoint === thisEndpoint && <Badge className="bg-tlb text-accent">This device</Badge>}
                      </div>
                      <div className="mt-0.5 text-[12px] text-muted">
                        {[d.service && `via ${d.service}`, `added ${ago(d.createdAt)}`, d.lastOkAt ? `last alert ${ago(d.lastOkAt)}` : "no alert yet"].filter(Boolean).join(" · ")}
                      </div>
                      {d.lastError && <div className="mt-1 break-words text-[12px] leading-snug text-bad">{d.lastError}</div>}
                    </div>
                    <Button size="sm" variant="ghost" className="text-bad" loading={busy === `rm:${d.id}`} onClick={() => remove(d.id)}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {view.recent.length > 0 && (
            <section>
              <Label className="mb-2.5">Recent alerts</Label>
              <ul className="space-y-2.5">
                {view.recent.slice(0, 6).map((r, i) => {
                  const chip = STATUS_CHIP[r.status];
                  const body = (
                    <>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-semibold text-ink">{r.title}</span>
                        {chip && <Badge className={chip.cls}>{chip.label}</Badge>}
                        <span className="ml-auto shrink-0 text-[11px] text-muted">{ago(r.at)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-[12.5px] text-muted">{r.body}</span>
                    </>
                  );
                  return (
                    <li key={`${r.at}-${i}`}>
                      {r.threadId ? (
                        <button
                          type="button"
                          className="block w-full rounded-lg px-2 py-1 text-left transition-colors hover:bg-hov"
                          onClick={() => {
                            openThread(r.threadId as string);
                            window.dispatchEvent(new CustomEvent("dna-open-thread", { detail: r.threadId }));
                            onClose();
                          }}
                        >
                          {body}
                        </button>
                      ) : (
                        <div className="px-2 py-1">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}

function ThisDevice({
  state,
  busy,
  onEnable,
  onDisable,
  onTest,
  installable,
  onInstall,
}: {
  state: DeviceState;
  busy: string;
  onEnable: () => void;
  onDisable: () => void;
  onTest: () => void;
  installable: boolean;
  onInstall: () => void;
}) {
  const label = deviceLabel();
  const pill =
    state.kind === "on"
      ? { t: "On", c: "bg-okb text-good" }
      : state.kind === "blocked"
        ? { t: "Blocked", c: "bg-dgb text-bad" }
        : state.kind === "off"
          ? { t: "Off", c: "bg-ink/[0.06] text-muted" }
          : state.kind === "ios-install"
            ? { t: "One step first", c: "bg-wnb text-warn" }
            : { t: "Not available", c: "bg-ink/[0.06] text-muted" };
  return (
    <section className={cn("rounded-xl border p-4", state.kind === "on" ? "border-keepl bg-keep1" : "border-line-soft bg-surf2")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-full border", state.kind === "on" ? "border-keepl text-accent" : "border-line-strong text-ink-soft")}>
            <Bell size={17} />
          </span>
          <div className="min-w-0">
            <Label>This device</Label>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <span className="text-[14.5px] font-[650]">{label}</span>
              <Badge className={pill.c}>{pill.t}</Badge>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {state.kind === "on" && (
            <>
              <Button size="sm" variant="outline" loading={busy === "test"} onClick={onTest}>
                Send a test
              </Button>
              <Button size="sm" variant="ghost" loading={busy === "off"} onClick={onDisable}>
                Turn off
              </Button>
            </>
          )}
          {state.kind === "off" && (
            <Button size="sm" loading={busy === "on"} onClick={onEnable}>
              Turn on alerts
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 text-[12.5px] leading-relaxed text-ink-soft">
        {state.kind === "on" && <p>Alerts arrive here, even when the app is closed.</p>}
        {state.kind === "off" && <p>Your browser asks once whether this site may show notifications. Choose Allow.</p>}
        {state.kind === "blocked" &&
          (isIos() ? (
            <p>
              Notifications are switched off for this app. On the iPhone: Settings → Notifications → <b>Outreach</b> → Allow Notifications, then come back
              here.
            </p>
          ) : (
            <p>
              Notifications are blocked for this site. Click the icon left of the address (the lock or the settings icon) → Notifications → Allow, then
              reload the page.
            </p>
          ))}
        {state.kind === "ios-install" && (
          <ol className="space-y-1.5">
            {[
              <>
                In Safari, tap <b>Share</b> (the square with the arrow).
              </>,
              <>
                Tap <b>Add to Home Screen</b>, then <b>Add</b>.
              </>,
              <>
                Open <b>Outreach</b> from the Home Screen, sign in, and turn alerts on from the bell there.
              </>,
            ].map((s, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-line-strong text-[11px] font-bold tabular-nums text-ink-soft">{i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
            <li className="pt-1 text-[12px] text-muted">iPhones and iPads only show web alerts from apps on the Home Screen (iOS 16.4 or later).</li>
          </ol>
        )}
        {state.kind === "unsupported" && <p>This browser can't show alerts. Use Chrome, Edge, Firefox or Safari on a computer, or install the app on your phone.</p>}
      </div>

      {installable && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-3">
          <p className="text-[12.5px] text-muted">Install the console as an app: its own window and icon, with the number of replies waiting on it.</p>
          <Button size="sm" variant="outline" loading={busy === "install"} onClick={onInstall}>
            Install app
          </Button>
        </div>
      )}
    </section>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        onChange(!checked);
      }}
      className={cn("relative mt-0.5 h-[20px] w-[34px] shrink-0 rounded-full transition-colors", checked ? "bg-brand" : "bg-ink/[0.14]")}
    >
      <span className={cn("absolute top-[3px] h-[14px] w-[14px] rounded-full bg-paper shadow transition-[left]", checked ? "left-[17px]" : "left-[3px]")} />
    </button>
  );
}
