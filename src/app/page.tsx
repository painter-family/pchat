import { Suspense } from "react";
import { AccountPanel } from "@/components/account-panel";

export default function Home() {
  return <Suspense fallback={<p className="p-8" role="status">Loading pchat…</p>}><AccountPanel /></Suspense>;
}
