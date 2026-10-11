import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiFailure } from "../api/client";
import type { Article, Comment, Errors } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { avatar } from "../components/ArticlePreview";
import { ErrorList } from "../components/ErrorList";
import { renderMarkdown } from "../lib/markdown";

export function ArticlePage() {
  const { slug = "" } = useParams();
  const { user, client } = useAuth();
  const navigate = useNavigate();
  const [article, setArticle] = useState<Article | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [draft, setDraft] = useState("");
  const [errors, setErrors] = useState<Errors | null>(null);

  const fail = (e: unknown) => setErrors(e instanceof ApiFailure ? e.errors : { app: ["failed"] });

  useEffect(() => {
    Promise.all([
      client.get<{ article: Article }>(`/articles/${slug}`),
      client.get<{ comments: Comment[] }>(`/articles/${slug}/comments`),
    ])
      .then(([a, c]) => {
        setArticle(a.article);
        setComments(c.comments);
      })
      .catch(fail);
  }, [client, slug]);

  async function postComment(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await client.post<{ comment: Comment }>(`/articles/${slug}/comments`, {
        comment: { body: draft },
      });
      setComments((cs) => [...cs, r.comment]);
      setDraft("");
    } catch (err) {
      fail(err);
    }
  }

  if (!article)
    return (
      <div className="container page">
        <ErrorList errors={errors} />
      </div>
    );
  const mine = user?.username === article.author.username;

  return (
    <div className="article-page">
      <div className="banner">
        <div className="container">
          <h1>{article.title}</h1>
          <div className="article-meta">
            <Link to={`/profile/${article.author.username}`}>
              <img src={avatar(article.author.image)} alt="" />
            </Link>
            <div className="info">
              <Link to={`/profile/${article.author.username}`} className="author">
                {article.author.username}
              </Link>
              <span className="date">{new Date(article.createdAt).toDateString()}</span>
            </div>
            {mine && (
              <>
                <Link className="btn btn-outline-secondary btn-sm" to={`/editor/${article.slug}`}>
                  <i className="ion-edit" /> Edit Article
                </Link>{" "}
                <button
                  className="btn btn-outline-danger btn-sm"
                  type="button"
                  onClick={() =>
                    client
                      .del(`/articles/${article.slug}`)
                      .then(() => navigate("/"))
                      .catch(fail)
                  }
                >
                  <i className="ion-trash-a" /> Delete Article
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="container page">
        <div className="row article-content">
          <div className="col-md-12">
            <div
              data-testid="article-body"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(article.body ?? "") }}
            />
            <ul className="tag-list">
              {article.tagList.map((t) => (
                <li key={t} className="tag-default tag-pill tag-outline">
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <hr />
        <div className="row">
          <div className="col-xs-12 col-md-8 offset-md-2">
            <ErrorList errors={errors} />
            {user ? (
              <form className="card comment-form" onSubmit={postComment}>
                <div className="card-block">
                  <textarea
                    className="form-control"
                    placeholder="Write a comment..."
                    rows={3}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                  />
                </div>
                <div className="card-footer">
                  <img src={avatar(user.image)} className="comment-author-img" alt="" />
                  <button className="btn btn-sm btn-primary" type="submit">
                    Post Comment
                  </button>
                </div>
              </form>
            ) : (
              <p>
                <Link to="/login">Sign in</Link> or <Link to="/register">sign up</Link> to add
                comments on this article.
              </p>
            )}
            {comments.map((c) => (
              <div className="card" key={c.id}>
                <div className="card-block">
                  <p className="card-text">{c.body}</p>
                </div>
                <div className="card-footer">
                  <Link to={`/profile/${c.author.username}`} className="comment-author">
                    <img src={avatar(c.author.image)} className="comment-author-img" alt="" />
                  </Link>{" "}
                  <Link to={`/profile/${c.author.username}`} className="comment-author">
                    {c.author.username}
                  </Link>
                  <span className="date-posted">{new Date(c.createdAt).toDateString()}</span>
                  {user?.username === c.author.username && (
                    <span className="mod-options">
                      <i
                        className="ion-trash-a"
                        role="button"
                        aria-label="Delete comment"
                        onClick={() =>
                          client
                            .del(`/articles/${slug}/comments/${c.id}`)
                            .then(() => setComments((cs) => cs.filter((x) => x.id !== c.id)))
                            .catch(fail)
                        }
                      />
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
