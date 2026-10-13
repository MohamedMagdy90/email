import { useEffect, useState } from "react";
import { api, type Template } from "../lib/api";
import { Button, Card, Field, Input, Modal, Select, Textarea, toast, cn, Badge } from "../lib/ui";
import { Header } from "./Contacts";
import { STARTERS } from "../lib/starters";

const TAGS = ["company", "country", "industry", "email"];
const SAMPLE = { company: "Acme Trading", country: "Qatar", industry: "Trading", email: "info@acme.com" };

function render(tpl: string, c: Record<string, string>) {
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => {
    const key = k.toLowerCase();
    if (c[key]) return c[key];
    if (key === "company") return "there";
    return "";
  });
}

export default function Templates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editing, setEditing] = useState<Template | null>(null);
  const [open, setOpen] = useState(false);

  async function load() {
    const r = await api.getTemplates();
    setTemplates(r.templates);
  }
  useEffect(() => { load(); }, []);

  function create() {
    setEditing({ id: "", type: "customer", name: "", subject: "", body: "", created_at: "" });
    setOpen(true);
  }
  function edit(t: Template) {
    setEditing(t);
    setOpen(true);
  }
  async function remove(t: Template) {
    if (!confirm(`Delete "${t.name}"?`)) return;
    await api.deleteTemplate(t.id);
    toast("Deleted", "success");
    load();
  }
  async function addStarters() {
    for (const s of STARTERS) await api.saveTemplate(s);
    toast("Starter templates added", "success");
    load();
  }

  const customer = templates.filter((t) => t.type === "customer");
  const partner = templates.filter((t) => t.type === "partner");

  return (
    <div>
      <Header
        title="Templates"
        subtitle="Reusable emails with merge tags. No AI — you're in full control of the copy."
        actions={
          <>
            {templates.length === 0 && (
              <Button variant="outline" size="sm" onClick={addStarters}>Add starter templates</Button>
            )}
            <Button size="sm" onClick={create}>New template</Button>
          </>
        }
      />

      {templates.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-16 text-center">
          <div className="prism-bar h-1.5 w-16 rounded-full opacity-60" />
          <div className="font-clash text-lg font-semibold">No templates yet</div>
          <p className="max-w-sm text-sm text-muted">
            Start from our pre-written customer & partner templates, or write your own.
          </p>
          <div className="mt-1 flex gap-2">
            <Button size="sm" variant="outline" onClick={addStarters}>Add starter templates</Button>
            <Button size="sm" onClick={create}>New template</Button>
          </div>
        </Card>
      ) : (
        <div className="space-y-8">
          <Group title="Customer" items={customer} onEdit={edit} onRemove={remove} />
          <Group title="Partner" items={partner} onEdit={edit} onRemove={remove} />
        </div>
      )}

      {editing && (
        <Editor
          key={editing.id || "new"}
          open={open}
          template={editing}
          onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); load(); }}
        />
      )}
    </div>
  );
}

function Group({
  title,
  items,
  onEdit,
  onRemove,
}: {
  title: string;
  items: Template[];
  onEdit: (t: Template) => void;
  onRemove: (t: Template) => void;
}) {
  if (!items.length) return null;
  return (
    <div>
      <div className="mono-label mb-3 text-muted">{title} · {items.length}</div>
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((t) => (
          <Card key={t.id} className="group flex flex-col p-4">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="font-clash text-base font-semibold">{t.name}</div>
              <Badge className={t.type === "partner" ? "bg-[#efe9ff] text-[#6b4ec7]" : "bg-[#eaf3ff] text-[#2563a8]"}>
                {t.type}
              </Badge>
            </div>
            <div className="mb-1 text-[13px] font-medium text-ink/80">{t.subject}</div>
            <div className="line-clamp-2 text-xs text-muted" dangerouslySetInnerHTML={{ __html: stripTags(t.body) }} />
            <div className="mt-3 flex gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={() => onEdit(t)}>Edit</Button>
              <Button size="sm" variant="ghost" onClick={() => onRemove(t)} className="text-bad">Delete</Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Editor({
  open,
  template,
  onClose,
  onSaved,
}: {
  open: boolean;
  template: Template;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [t, setT] = useState(template);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"edit" | "preview">("edit");

  function insertTag(tag: string) {
    setT({ ...t, body: t.body + `{{${tag}}}` });
  }

  async function save() {
    if (!t.name || !t.subject || !t.body) return toast("Name, subject and body are required", "error");
    setBusy(true);
    try {
      if (t.id) await api.updateTemplate(t.id, t);
      else await api.saveTemplate(t);
      toast("Saved", "success");
      onSaved();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t.id ? "Edit template" : "New template"} wide>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Type">
            <Select value={t.type} onChange={(e) => setT({ ...t, type: e.target.value as any })}>
              <option value="customer">Customer</option>
              <option value="partner">Partner</option>
            </Select>
          </Field>
          <div className="col-span-2">
            <Field label="Template name">
              <Input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder="Customer — Intro" />
            </Field>
          </div>
        </div>

        <Field label="Subject">
          <Input value={t.subject} onChange={(e) => setT({ ...t, subject: e.target.value })} />
        </Field>

        <div className="flex items-center gap-2">
          <div className="flex rounded-full border border-line bg-paper p-1">
            {(["edit", "preview"] as const).map((x) => (
              <button
                key={x}
                onClick={() => setTab(x)}
                className={cn(
                  "rounded-full px-3 py-1 text-[13px] font-medium capitalize",
                  tab === x ? "bg-ink text-cream" : "text-ink/55"
                )}
              >
                {x}
              </button>
            ))}
          </div>
          <div className="ml-auto flex flex-wrap gap-1.5">
            {TAGS.map((tag) => (
              <button
                key={tag}
                onClick={() => insertTag(tag)}
                className="rounded-md border border-line bg-white px-2 py-1 font-mono text-[11px] text-ink/70 hover:border-ink/40"
              >
                {`{{${tag}}}`}
              </button>
            ))}
          </div>
        </div>

        {tab === "edit" ? (
          <Textarea
            rows={12}
            value={t.body}
            onChange={(e) => setT({ ...t, body: e.target.value })}
            placeholder="Write your email. HTML is supported."
            className="font-mono text-xs"
          />
        ) : (
          <div className="rounded-xl border border-line bg-white p-5">
            <div className="mb-3 border-b border-line-soft pb-2 text-sm">
              <span className="text-muted">Subject: </span>
              <span className="font-medium">{render(t.subject, SAMPLE)}</span>
            </div>
            <div
              className="prose-sm max-w-none text-sm leading-relaxed [&_a]:text-[#2563a8] [&_p]:mb-3"
              dangerouslySetInnerHTML={{ __html: render(t.body, SAMPLE) }}
            />
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={busy} onClick={save}>Save template</Button>
        </div>
      </div>
    </Modal>
  );
}

function stripTags(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
