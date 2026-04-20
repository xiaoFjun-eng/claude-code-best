import { useCallback, useMemo, useRef } from 'react'

const DEFAULT_MAX_VISIBLE = 5

type UsePaginationOptions = {
  totalItems: number
  maxVisible?: number
  selectedIndex?: number
}

type UsePaginationResult<T> = {
  // 为保持与基于页面术语的向后兼容性
  currentPage: number
  totalPages: number
  startIndex: number
  endIndex: number
  needsPagination: boolean
  pageSize: number
  // 获取项目的可见切片
  getVisibleItems: (items: T[]) => T[]
  // 将可见索引转换为实际索引
  toActualIndex: (visibleIndex: number) => number
  // 检查实际索引是否可见
  isOnCurrentPage: (actualIndex: number) => boolean
  // 导航（为保持 API 兼容性而保留）
  goToPage: (page: number) => void
  nextPage: () => void
  prevPage: () => void
  // 处理选择 - 仅更新索引，滚动是自动的
  handleSelectionChange: (
    newIndex: number,
    setSelectedIndex: (index: number) => void,
  ) => void
  // 页面导航 - 对于连续滚动返回 false（不需要）
  handlePageNavigation: (
    direction: 'left' | 'right',
    setSelectedIndex: (index: number) => void,
  ) => boolean
  // 用于 UI 显示的滚动位置信息
  scrollPosition: {
    current: number
    total: number
    canScrollUp: boolean
    canScrollDown: boolean
  }
}

export function usePagination<T>({
  totalItems,
  maxVisible = DEFAULT_MAX_VISIBLE,
  selectedIndex = 0,
}: UsePaginationOptions): UsePaginationResult<T> {
  const needsPagination = totalItems > maxVisible

  // 使用 ref 跟踪先前的滚动偏移以实现平滑滚动
  const scrollOffsetRef = useRef(0)

  // 基于 selectedIndex
  // 计算滚动偏移，确保选中项始终可见
  const scrollOffset = useMemo(() => {
    if (!needsPagination) return 0

    const prevOffset = scrollOffsetRef.current

    // 如果选中项位于可见窗口上方，则向上滚动
    if (selectedIndex < prevOffset) {
      scrollOffsetRef.current = selectedIndex
      return selectedIndex
    }

    // 如果选中项位于可见窗口下方，则向下滚动
    if (selectedIndex >= prevOffset + maxVisible) {
      const newOffset = selectedIndex - maxVisible + 1
      scrollOffsetRef.current = newOffset
      return newOffset
    }

    // 选中项在可见窗口内，保持当前偏移，
    // 但确保偏移仍然有效
    const maxOffset = Math.max(0, totalItems - maxVisible)
    const clampedOffset = Math.min(prevOffset, maxOffset)
    scrollOffsetRef.current = clampedOffset
    return clampedOffset
  }, [selectedIndex, maxVisible, needsPagination, totalItems])

  const startIndex = scrollOffset
  const endIndex = Math.min(scrollOffset + maxVisible, totalItems)

  const getVisibleItems = useCallback(
    (items: T[]): T[] => {
      if (!needsPagination) return items
      return items.slice(startIndex, endIndex)
    },
    [needsPagination, startIndex, endIndex],
  )

  const toActualIndex = useCallback(
    (visibleIndex: number): number => {
      return startIndex + visibleIndex
    },
    [startIndex],
  )

  const isOnCurrentPage = useCallback(
    (actualIndex: number): boolean => {
      return actualIndex >= startIndex && actualIndex < endIndex
    },
    [startIndex, endIndex],
  )

  // 这些对于连续滚动大多是无操作，但为保持 API 兼容性而保留
  const goToPage = useCallback((_page: number) => {
    // 无操作 - 滚动由 selectedIndex 控制
  }, [])

  const nextPage = useCallback(() => {
    // 无操作 - 滚动由 selectedIndex 控制
  }, [])

  const prevPage = useCallback(() => {
    // 无操作 - 滚动由 selectedIndex 控制
  }, [])

  // 简单的选择处理器 - 仅更新索引，
  // 滚动通过上述 useMemo 自动发生
  const handleSelectionChange = useCallback(
    (newIndex: number, setSelectedIndex: (index: number) => void) => {
      const clampedIndex = Math.max(0, Math.min(newIndex, totalItems - 1))
      setSelectedIndex(clampedIndex)
    },
    [totalItems],
  )

  // 页面导航 - 对连续滚动已禁用
  const handlePageNavigation = useCallback(
    (
      _direction: 'left' | 'right',
      _setSelectedIndex: (index: number) => void,
    ): boolean => {
      return false
    },
    [],
  )

  // 为向后兼容性计算类似页面的值
  const totalPages = Math.max(1, Math.ceil(totalItems / maxVisible))
  const currentPage = Math.floor(scrollOffset / maxVisible)

  return {
    currentPage,
    totalPages,
    startIndex,
    endIndex,
    needsPagination,
    pageSize: maxVisible,
    getVisibleItems,
    toActualIndex,
    isOnCurrentPage,
    goToPage,
    nextPage,
    prevPage,
    handleSelectionChange,
    handlePageNavigation,
    scrollPosition: {
      current: selectedIndex + 1,
      total: totalItems,
      canScrollUp: scrollOffset > 0,
      canScrollDown: scrollOffset + maxVisible < totalItems,
    },
  }
}
