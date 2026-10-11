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
