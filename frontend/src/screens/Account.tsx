import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Button, Field, Input, Modal, toast } from "../lib/ui";

/* Change the console's login. Opened from "account" in the brand bar. The
   current password confirms every change; the API returns a fresh token. */
export default function AccountDialog({
  open,
  username,
  onClose,
  onRenamed,
}: {
  open: boolean;
  username: string;
  onClose: () => void;
  onRenamed: (username: string) => void;
}) {
  const [current, setCurrent] = useState("");
  const [name, setName] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  // Start clean every time it opens.
  useEffect(() => {
    if (!open) return;
    setCurrent("");
    setName("");
    setNext("");
    setConfirm("");
  }, [open]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const newName = name.trim();
    if (!current) return toast("Enter your current password to confirm the change", "error");
    if (!newName && !next) return toast("Nothing to change", "info");
    if (newName && newName.length < 3) return toast("Username must be at least 3 characters", "error");
    if (next && next.length < 6) return toast("New password must be at least 6 characters", "error");
    if (next && next !== confirm) return toast("New passwords don't match", "error");
    setBusy(true);
    try {
      const r = await api.updateAccount({
        currentPassword: current,
        username: newName || undefined,
        newPassword: next || undefined,
      });
      onRenamed(r.username);
      toast(newName ? `Account updated. You sign in as "${r.username}" now.` : "Password updated", "success");
      onClose();
    } catch (err: any) {
      toast(err?.message || "Couldn't update the account", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Account">
      <form onSubmit={save} className="space-y-4">
        <p className="text-[13px] leading-relaxed text-muted">
          Signed in as <b className="font-semibold text-ink">{username || "admin"}</b>. Change the username or the password,
          then confirm with your current password.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New username" hint="Leave blank to keep it.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={username || "Username"} autoComplete="username" />
          </Field>
          <div className="hidden sm:block" />
          <Field label="New password" hint="Leave blank to keep it.">
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="At least 6 characters" autoComplete="new-password" />
          </Field>
          <Field label="Repeat new password">
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat it" autoComplete="new-password" />
          </Field>
        </div>
        <div className="border-t border-line-soft pt-4">
          <Field label="Current password">
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Confirms the change" autoComplete="current-password" />
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Save changes
          </Button>
        </div>
      </form>
    </Modal>
  );
}
