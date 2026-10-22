"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="center-page">
      <div className="card">
        <h1 className="t-title">Something broke</h1>
        <p className="muted">The page could not load. Try again; if it keeps failing, check the server logs.</p>
        {error.digest ? <p className="t-caption muted">Reference: {error.digest}</p> : null}
        <p>
          <button type="button" className="btn btn-primary" onClick={reset}>
            Try again
          </button>
        </p>
      </div>
    </main>
  );
}
