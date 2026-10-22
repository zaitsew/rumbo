import Link from "next/link";

export function CompassGlyph({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <path d="M16 7.5 19.2 16 16 24.5 12.8 16Z" fill="currentColor" />
    </svg>
  );
}

export function Logo() {
  return (
    <Link href="/" className="logo" aria-label="Rumbo home">
      <CompassGlyph />
      <span>Rumbo</span>
    </Link>
  );
}
