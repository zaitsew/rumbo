import type { Metadata } from "next";
import { ProfileForm } from "../../../components/ProfileForm";
import { store } from "../../../src/server/store";

export const metadata: Metadata = { title: "Profile" };
export const dynamic = "force-dynamic";

export default function ProfilePage() {
  return (
    <>
      <div>
        <h1 className="t-title">Profile</h1>
        <p className="muted">What the feed and the planner know about you. Agents can add notes through the API.</p>
      </div>
      <ProfileForm profile={store().getProfile()} />
    </>
  );
}
