import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { ApiFailure } from "../api/client";
import type { Article, Errors } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { ErrorList } from "../components/ErrorList";

const toTags = (s: string) =>
  s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

export function Editor() {
  const { slug } = useParams();
  const { user, ready, client } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ title: "", description: "", body: "", tags: "" });
  const [errors, setErrors] = useState<Errors | null>(null);

  useEffect(() => {
    if (!slug) return;
    client
      .get<{ article: Article }>(`/articles/${slug}`)
      .then(({ article: a }) =>
        setForm({
          title: a.title,
          description: a.description,
          body: a.body ?? "",
          tags: a.tagList.join(", "),
        }),
      )
      .catch((e: unknown) => setErrors(e instanceof ApiFailure ? e.errors : { app: ["failed"] }));
  }, [client, slug]);

  if (ready && !user) return <Navigate to="/login" />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErrors(null);
    const article = {
      title: form.title,
      description: form.description,
      body: form.body,
      tagList: toTags(form.tags),
    };
    try {
      const r = slug
        ? await client.put<{ article: Article }>(`/articles/${slug}`, { article })
        : await client.post<{ article: Article }>("/articles", { article });
      navigate(`/article/${r.article.slug}`);
    } catch (err) {
      setErrors(err instanceof ApiFailure ? err.errors : { app: ["failed"] });
    }
  }

  return (
    <div className="editor-page">
      <div className="container page">
        <div className="row">
          <div className="col-md-10 offset-md-1 col-xs-12">
            <ErrorList errors={errors} />
            <form onSubmit={submit}>
              <fieldset>
                <fieldset className="form-group">
                  <input
                    className="form-control form-control-lg"
                    placeholder="Article Title"
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                  />
                </fieldset>
                <fieldset className="form-group">
                  <input
                    className="form-control"
                    placeholder="What's this article about?"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                  />
                </fieldset>
                <fieldset className="form-group">
                  <textarea
                    className="form-control"
                    rows={8}
                    placeholder="Write your article (in markdown)"
                    value={form.body}
                    onChange={(e) => setForm({ ...form, body: e.target.value })}
                  />
                </fieldset>
                <fieldset className="form-group">
                  <input
                    className="form-control"
                    placeholder="Enter tags"
                    value={form.tags}
                    onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  />
                </fieldset>
                <button className="btn btn-lg pull-xs-right btn-primary" type="submit">
                  Publish Article
                </button>
              </fieldset>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
