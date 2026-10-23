"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Feed" },
  { href: "/plan", label: "Plan" },
  { href: "/watches", label: "Watches" },
  { href: "/profile", label: "Profile" },
  { href: "/agents", label: "Agents" },
] as const;

export function NavLinks() {
  const path = usePathname();
  return (
    <>
      {LINKS.map((l) => {
        const active = l.href === "/" ? path === "/" : path === l.href || path.startsWith(`${l.href}/`);
        return (
          <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined}>
            {l.label}
          </Link>
        );
      })}
    </>
  );
}
