export function matchesTopicGlob(topic: string, filter: string): boolean {
  return topicGlobToRegExp(filter).test(topic);
}

function topicGlobToRegExp(filter: string): RegExp {
  let pattern = "^";
  for (let index = 0; index < filter.length; index++) {
    const char = filter[index];
    if (char === "*") {
      if (filter[index + 1] === "*") {
        pattern += ".*";
        index++;
      } else {
        pattern += "[^.]*";
      }
      continue;
    }
    pattern += escapeRegex(char);
  }
  return new RegExp(`${pattern}$`);
}

function escapeRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
