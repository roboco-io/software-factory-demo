export const handler = async (c: any) => {
  const body = await c.req.json();
  if (body.bio.length > 500) {
    return c.json({ errors: { bio: ["must be 500 characters or less"] } }, 422);
  }
  return c.json({ ok: true });
};
