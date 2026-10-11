import type { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { isGoogleAuthConfigured } from "@/lib/auth-config";

function unavailable() {
  return Response.json(
    { error: "Google sign-in is not available yet." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: NextRequest) {
  return isGoogleAuthConfigured() ? handlers.GET(request) : unavailable();
}

export async function POST(request: NextRequest) {
  return isGoogleAuthConfigured() ? handlers.POST(request) : unavailable();
}
