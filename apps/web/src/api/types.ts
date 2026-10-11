export type User = {
  email: string;
  token: string;
  username: string;
  bio: string | null;
  image: string | null;
};
export type Profile = {
  username: string;
  bio: string | null;
  image: string | null;
  following: boolean;
};
export type Article = {
  slug: string;
  title: string;
  description: string;
  body?: string;
  tagList: string[];
  createdAt: string;
  updatedAt: string;
  favorited: boolean;
  favoritesCount: number;
  author: Profile;
};
export type Comment = {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: Profile;
};
export type Errors = Record<string, string[]>;
