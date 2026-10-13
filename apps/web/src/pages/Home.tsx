import { ArticleList } from "../components/ArticleList";

export function Home() {
  return (
    <div className="home-page">
      <div className="banner">
        <div className="container">
          <h1 className="logo-font">conveyor</h1>
          <p>A place to share your knowledge.</p>
        </div>
      </div>
      <div className="container page">
        <div className="row">
          <div className="col-md-12">
            <div className="feed-toggle">
              <ul className="nav nav-pills outline-active">
                <li className="nav-item">
                  <span className="nav-link active">Global Feed</span>
                </li>
              </ul>
            </div>
            <ArticleList query="" />
          </div>
        </div>
      </div>
    </div>
  );
}
