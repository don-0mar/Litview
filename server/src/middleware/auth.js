import jwt from "jsonwebtoken";
import { HttpError } from "../lib/http.js";

export function signToken(config, user) {
  return jwt.sign({ sub: user.id, name: user.name }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

/** Reads "Authorization: Bearer <token>" and sets req.user = { id, name }. */
export function authenticate(config, { required = true } = {}) {
  return (req, _res, next) => {
    const h = req.get("authorization") || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) {
      if (required) return next(new HttpError(401, "Sign in to do this."));
      return next();
    }
    try {
      const p = jwt.verify(token, config.jwtSecret);
      req.user = { id: p.sub, name: p.name };
      next();
    } catch {
      next(new HttpError(401, "Your session has expired. Sign in again."));
    }
  };
}
