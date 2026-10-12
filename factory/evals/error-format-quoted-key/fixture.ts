export const handler = async (c: any) => {
  const body = await c.req.json();
  if (body.description.length > 300) {
    return c.json({ "errors": { description: ["must be 300 characters or less"] } }, 422);
  }
  return c.json({ ok: true });
};
