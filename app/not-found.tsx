import Link from "next/link";

export default function NotFound() {
  return (
    <main className="center-page">
      <div className="card">
        <h1 className="t-title">That page is not here</h1>
        <p className="muted">The link may be old, or the page has not been built yet.</p>
        <p>
          <Link href="/" className="btn btn-primary">
            Back to the feed
          </Link>
        </p>
      </div>
    </main>
  );
}
