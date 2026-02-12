import React from 'react';
import ReactMarkdown from 'react-markdown';
import readMeMd from '../../../README.md?raw';

const UsagePage: React.FC = () => {
  return (
    <div className="markdown-content">
      <ReactMarkdown>{readMeMd}</ReactMarkdown>
    </div>
  );
};

export default UsagePage;
