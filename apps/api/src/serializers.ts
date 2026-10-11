type UserRow = { email: string; username: string; bio: string | null; image: string | null };

export const serializeUser = (u: UserRow, token: string) => ({
  email: u.email,
  token,
  username: u.username,
  bio: u.bio,
  image: u.image,
});

// 팩토리 데모용으로 남긴 기능: 즐겨찾기(팔로우) 구현 시 함께 바꾼다 (routes/deferred.ts 참고)
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
  // 팩토리 데모용으로 남긴 기능: 즐겨찾기(팔로우) 구현 시 함께 바꾼다 (routes/deferred.ts 참고)
  favorited: false,
  favoritesCount: 0,
  author: serializeProfile(author, false),
});

type CommentRow = { id: number; body: string; createdAt: string; updatedAt: string };

export const serializeComment = (
  c: CommentRow,
  author: Pick<UserRow, "username" | "bio" | "image">,
) => ({
  id: c.id,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  body: c.body,
  author: serializeProfile(author, false),
});
