const randomSuffix = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join("");

export function slugify(title: string, rand: () => string = randomSuffix): string {
  const base =
    title
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "article";
  return `${base}-${rand()}`;
}
