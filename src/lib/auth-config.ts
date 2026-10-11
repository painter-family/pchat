export function isGoogleAuthConfigured() {
  return [
    process.env.AUTH_SECRET,
    process.env.AUTH_GOOGLE_ID,
    process.env.AUTH_GOOGLE_SECRET,
  ].every((value) => Boolean(value?.trim()));
}
