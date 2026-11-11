import { memo, useRef, useState, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { IconCheck, IconCopy } from './icons';

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function CodeBlock(props: ComponentProps<'pre'>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await copyText(ref.current?.innerText ?? '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="codeblock">
      <button className="codeblock-copy" onClick={copy} title="Скопировать">
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </button>
      <pre ref={ref}>{props.children}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: CodeBlock,
          a: ({ node: _node, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
          table: ({ node: _node, ...p }) => (
            <div className="md-table">
              <table {...p} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
