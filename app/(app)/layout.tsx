import { signOutAction } from "../signin/actions";
import { Logo } from "../../components/Logo";
import { NavLinks } from "../../components/NavLinks";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="topbar">
        <div className="wrap">
          <Logo />
          <nav className="nav" aria-label="Main">
            <NavLinks />
            <form action={signOutAction}>
              <button type="submit">Sign out</button>
            </form>
          </nav>
        </div>
      </header>
      <main className="wrap page">{children}</main>
    </>
  );
}
