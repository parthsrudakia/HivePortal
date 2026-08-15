import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { canEditLedger } from "@/lib/access";

// "/s" is the public cleaner schedule page (token in the path, no login);
// "/sign" is the public tenant lease-signing page (token in the path);
// "/docs" and "/developers" are public API documentation.
const PUBLIC_PATHS = ["/login", "/auth", "/s", "/sign", "/docs", "/developers"];

// Host of the neutral signing domain (SIGN_ORIGIN). Requests arriving on it
// may only reach the public /sign pages — everything else 404s, so the
// unbranded domain can never surface the Hive Portal login or its name.
function signHost(): string | null {
  const raw = process.env.SIGN_ORIGIN?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const requestHost = request.headers.get("host");
  const neutralHost = signHost();
  if (neutralHost && requestHost === neutralHost) {
    if (request.nextUrl.pathname.startsWith("/sign")) {
      // Public token page — no session work needed on this host.
      return response;
    }
    return new NextResponse(null, { status: 404 });
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getClaims verifies the JWT locally (WebCrypto + cached JWKS — the project
  // uses asymmetric ES256 keys), so the middleware adds no auth round-trip.
  // Token refresh still happens through the cookie handlers when it expires.
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims ?? null;

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // The operations guidebook PDF is a static asset, so its access check
  // lives here: operators (Vineet + Parth) only.
  if (
    path === "/guidebook.pdf" &&
    !canEditLedger((user?.email as string | undefined) ?? null)
  ) {
    return new NextResponse(null, { status: 404 });
  }

  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return response;
}
