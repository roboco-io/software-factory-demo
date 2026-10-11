import { NavLink } from "react-router";
import { useAuth } from "../auth/AuthContext";

export function Header() {
  const { user } = useAuth();
  const item = (to: string, label: string) => (
    <li className="nav-item">
      <NavLink className="nav-link" to={to} end>
        {label}
      </NavLink>
    </li>
  );
  return (
    <nav className="navbar navbar-light">
      <div className="container">
        <NavLink className="navbar-brand" to="/">
          conduit
        </NavLink>
        <ul className="nav navbar-nav pull-xs-right">
          {item("/", "Home")}
          {user ? (
            <>
              {item("/editor", "New Article")}
              {item("/settings", "Settings")}
              {item(`/profile/${user.username}`, user.username)}
            </>
          ) : (
            <>
              {item("/login", "Sign in")}
              {item("/register", "Sign up")}
            </>
          )}
        </ul>
      </div>
    </nav>
  );
}
