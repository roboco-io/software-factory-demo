import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { API_BASE, ApiFailure, createClient, type Client } from "../api/client";
import type { User } from "../api/types";

const KEY = "jwt";
type AuthState = {
  user: User | null;
  ready: boolean;
  client: Client;
  signIn(u: User): void;
  signOut(): void;
};
const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const client = useMemo(() => createClient(API_BASE, () => localStorage.getItem(KEY)), []);

  const signIn = useCallback((u: User) => {
    localStorage.setItem(KEY, u.token);
    setUser(u);
  }, []);
  const signOut = useCallback(() => {
    localStorage.removeItem(KEY);
    setUser(null);
  }, []);

  useEffect(() => {
    if (!localStorage.getItem(KEY)) {
      setReady(true);
      return;
    }
    client
      .get<{ user: User }>("/user")
      .then((r) => signIn(r.user))
      .catch((e: unknown) => {
        if (e instanceof ApiFailure && e.status === 401) signOut();
      })
      .finally(() => setReady(true));
  }, [client, signIn, signOut]);

  const value = useMemo(
    () => ({ user, ready, client, signIn, signOut }),
    [user, ready, client, signIn, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside AuthProvider");
  return v;
}
