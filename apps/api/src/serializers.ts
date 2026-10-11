type UserRow = { email: string; username: string; bio: string | null; image: string | null };

export const serializeUser = (u: UserRow, token: string) => ({
  email: u.email,
  token,
  username: u.username,
  bio: u.bio,
  image: u.image,
});

export const serializeProfile = (
  u: Pick<UserRow, "username" | "bio" | "image">,
  following: boolean,
) => ({
  username: u.username,
  bio: u.bio,
  image: u.image,
  following,
});

type ArticleRow = {
  slug: string;
  title: string;
  description: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export const serializeArticle = (
  a: ArticleRow,
  tagList: string[],
  author: Pick<UserRow, "username" | "bio" | "image">,
  opts: { body: boolean },
) => ({
  slug: a.slug,
  title: a.title,
  description: a.description,
  ...(opts.body ? { body: a.body } : {}),
  tagList,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
  favorited: false,
  favoritesCount: 0,
  author: serializeProfile(author, false),
});
