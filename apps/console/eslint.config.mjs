import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  // Routes the Vercel Workflow plugin generates at build time (gitignored).
  { ignores: ["src/app/.well-known/workflow/**"] },
  ...nextVitals,
  {
    rules: {
      "import/no-anonymous-default-export": "off",
      "react-hooks/incompatible-library": "off",
      // `/<org>` matches every first URL segment, so this Pages Router rule
      // reads route handlers such as `/logout` as pages. Plain `<a>` is right there.
      "@next/next/no-html-link-for-pages": "off",
    },
  },
];

export default eslintConfig;
