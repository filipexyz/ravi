/** Fixed copy for access request errors shown in the browser; never echoes input. */
export function accessRequestErrorMessage(code: string) {
  switch (code) {
    case "rate_limited":
      return "You sent many requests today. Try again tomorrow.";
    case "password_route":
      return "This page is protected by a password. Ask whoever shared it for the password.";
    case "validation_failed":
      return "Keep the message under 500 characters.";
    case "request_decided":
      return "Someone already decided this request.";
    case "request_expired":
      return "This request expired. They can ask again from the page.";
    case "forbidden":
      return "Only people who can publish to this page's project can decide.";
    case "impersonated":
      return "Requests can't be decided while impersonating someone.";
    default:
      return "Something went wrong. Nothing changed; try again.";
  }
}
