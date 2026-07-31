import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const remarkPlugins = [remarkGfm];

export const AgentMessageMarkdown = memo(function AgentMessageMarkdown({
  content,
}: {
  content: string;
}) {
  return (
    <div className="agent-message-markdown">
      <ReactMarkdown disallowedElements={["img"]} remarkPlugins={remarkPlugins} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
});
