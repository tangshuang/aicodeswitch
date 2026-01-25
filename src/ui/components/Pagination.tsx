import React from 'react';

interface PaginationProps {
  currentPage: number;           // 当前页码（从1开始）
  totalItems: number;             // 总条数
  pageSize: number;               // 每页条数
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: number[];    // 默认 [10, 20, 50, 100]
}

export const Pagination: React.FC<PaginationProps> = ({
  currentPage,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50, 100],
}) => {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  const isFirstPage = currentPage === 1;
  const isLastPage = currentPage >= totalPages;

  const handleFirstPage = () => {
    if (!isFirstPage) {
      onPageChange(1);
    }
  };

  const handlePreviousPage = () => {
    if (!isFirstPage) {
      onPageChange(currentPage - 1);
    }
  };

  const handleNextPage = () => {
    if (!isLastPage) {
      onPageChange(currentPage + 1);
    }
  };

  const handleLastPage = () => {
    if (!isLastPage) {
      onPageChange(totalPages);
    }
  };

  const handlePageSizeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newSize = parseInt(e.target.value, 10);
    onPageSizeChange(newSize);
  };

  return (
    <div className="pagination">
      <div className="pagination-info">
        共 {totalItems} 条
      </div>

      <div className="pagination-controls">
        <button
          className="pagination-btn"
          onClick={handleFirstPage}
          disabled={isFirstPage}
        >
          首页
        </button>
        <button
          className="pagination-btn"
          onClick={handlePreviousPage}
          disabled={isFirstPage}
        >
          上一页
        </button>

        <span className="pagination-info">
          第 {currentPage} / {totalPages} 页
        </span>

        <button
          className="pagination-btn"
          onClick={handleNextPage}
          disabled={isLastPage}
        >
          下一页
        </button>
        <button
          className="pagination-btn"
          onClick={handleLastPage}
          disabled={isLastPage}
        >
          尾页
        </button>
      </div>

      <div className="pagination-size">
        <label>
          每页显示
          <select
            className="pagination-select"
            value={pageSize}
            onChange={handlePageSizeChange}
          >
            {pageSizeOptions.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          条
        </label>
      </div>
    </div>
  );
};
