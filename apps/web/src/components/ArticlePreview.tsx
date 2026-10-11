import { Link } from "react-router";
import type { Article } from "../api/types";

export const avatar = (image: string | null) => image ?? "./default-avatar.svg";

export function ArticlePreview({ article }: { article: Article }) {
  return (
    <div className="article-preview">
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
      </div>
      <Link to={`/article/${article.slug}`} className="preview-link">
        <h1>{article.title}</h1>
        <p>{article.description}</p>
        <span>Read more...</span>
        <ul className="tag-list">
          {article.tagList.map((t) => (
            <li key={t} className="tag-default tag-pill tag-outline">
              {t}
            </li>
          ))}
        </ul>
      </Link>
    </div>
  );
}
