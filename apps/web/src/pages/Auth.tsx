import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ApiFailure } from "../api/client";
import type { Errors, User } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { ErrorList } from "../components/ErrorList";

export function Auth({ mode }: { mode: "login" | "register" }) {
  const { client, signIn } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ username: "", email: "", password: "" });
  const [errors, setErrors] = useState<Errors | null>(null);
  const [busy, setBusy] = useState(false);
  const isRegister = mode === "register";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors(null);
    try {
      const user = isRegister ? form : { email: form.email, password: form.password };
      const r = await client.post<{ user: User }>(isRegister ? "/users" : "/users/login", { user });
      signIn(r.user);
      navigate("/");
    } catch (err) {
      setErrors(err instanceof ApiFailure ? err.errors : { app: ["failed"] });
    } finally {
      setBusy(false);
    }
  }

  const field = (name: keyof typeof form, placeholder: string, type = "text") => (
    <fieldset className="form-group">
      <input
        className="form-control form-control-lg"
        type={type}
        placeholder={placeholder}
        value={form[name]}
        onChange={(e) => setForm({ ...form, [name]: e.target.value })}
      />
    </fieldset>
  );

  return (
    <div className="auth-page">
      <div className="container page">
        <div className="row">
          <div className="col-md-6 offset-md-3 col-xs-12">
            <h1 className="text-xs-center">{isRegister ? "Sign up" : "Sign in"}</h1>
            <p className="text-xs-center">
              {isRegister ? (
                <Link to="/login">Have an account?</Link>
              ) : (
                <Link to="/register">Need an account?</Link>
              )}
            </p>
            <ErrorList errors={errors} />
            <form onSubmit={submit}>
              {isRegister && field("username", "Username")}
              {field("email", "Email", "email")}
              {field("password", "Password", "password")}
              <button
                className="btn btn-lg btn-primary pull-xs-right"
                type="submit"
                disabled={busy}
              >
                {isRegister ? "Sign up" : "Sign in"}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
