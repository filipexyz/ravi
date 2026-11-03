import { Suspense } from "react";
import { SetupScreen } from "@/features/org/setup-screen";
export const dynamic = "force-dynamic";
export default function SetupPage() { return <Suspense fallback={<p>Carregando…</p>}><SetupScreen /></Suspense>; }
