// One section of the Settings page (Model, Search, Connection, …), in the
// same card as the setup wizard's, so the two read as one surface.
export function SettingsCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 sm:p-5">
      {children}
    </div>
  );
}
