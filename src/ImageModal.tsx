import React, { useEffect } from 'react';

interface ImageMetadata {
  filename: string;
  lastModified: string; // ISO 8601 date string
  size: number; // Bytes
  contentType: string; // e.g., image/jpeg
}

interface ImageModalProps {
  imageUrl: string;
  alt: string;
  metadata: ImageMetadata;
  onClose: () => void;
  onPreviousImage: () => void;
  onNextImage: () => void;
  hasPreviousImage: boolean;
  hasNextImage: boolean;
}

const ImageModal: React.FC<ImageModalProps> = ({
  imageUrl,
  alt,
  metadata,
  onClose,
  onPreviousImage,
  onNextImage,
  hasPreviousImage,
  hasNextImage,
}) => {
  // Close modal on Esc key
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Format file size (e.g., KB, MB)
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Format date (e.g., "April 18, 2025, 12:00 PM")
  const formatDate = (isoDate: string): string => {
    return new Date(isoDate).toLocaleString('en-US', {
      dateStyle: 'long',
      timeStyle: 'short',
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4 modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-label="Full-size image modal"
    >
      <div
        className="relative bg-white rounded-lg max-w-[90vw] max-h-[90vh] flex flex-col modal-content"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={imageUrl}
          alt={alt}
          className="max-w-full max-h-[70vh] object-contain rounded-t-lg"
        />
        <div className="p-4 text-gray-800">
          <h3 className="text-lg font-semibold mb-2">Image Metadata</h3>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
            <div>
              <dt className="font-medium">Filename:</dt>
              <dd>{metadata.filename}</dd>
            </div>
            <div>
              <dt className="font-medium">Last Modified:</dt>
              <dd>{formatDate(metadata.lastModified)}</dd>
            </div>
            <div>
              <dt className="font-medium">File Size:</dt>
              <dd>{formatFileSize(metadata.size)}</dd>
            </div>
            <div>
              <dt className="font-medium">Content Type:</dt>
              <dd>{metadata.contentType}</dd>
            </div>
          </dl>
          <div className="flex justify-between mt-4">
            <button
              onClick={onPreviousImage}
              disabled={!hasPreviousImage}
              className={`px-4 py-2 rounded ${
                hasPreviousImage
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              } focus:outline-none focus:ring-2 focus:ring-blue-500`}
              aria-label="Previous image"
            >
              Previous Image
            </button>
            <button
              onClick={onNextImage}
              disabled={!hasNextImage}
              className={`px-4 py-2 rounded ${
                hasNextImage
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              } focus:outline-none focus:ring-2 focus:ring-blue-500`}
              aria-label="Next image"
            >
              Next Image
            </button>
          </div>
        </div>
        <button
          className="absolute top-2 right-2 bg-white text-black rounded-full p-2 hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-white"
          onClick={onClose}
          aria-label="Close modal"
        >
          <svg
            className="w-6 h-6"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default ImageModal;