/**
 * Static "BETA" badge shown next to the title.
 *
 * We deliberately do NOT show a version number here. This is the WebUI client;
 * it cannot reliably know which EvoScientist backend version the user actually
 * has installed, so showing the latest PyPI release would falsely imply they're
 * running it. "BETA" honestly signals an early-stage product without making a
 * version claim — and needs no network request.
 */
export function BetaBadge() {
  return (
    <span className="border-[var(--brand)]/30 bg-[var(--brand)]/10 hidden rounded-lg border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--brand)] shadow-sm backdrop-blur-sm min-[420px]:inline-flex">
      BETA
    </span>
  );
}
