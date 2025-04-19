import { useState, useEffect, useRef, useCallback } from 'react';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import ImageModal from './ImageModal';
import { VERSION_NUMBER_MAJOR, VERSION_NUMBER_MINOR, VERSION_NUMBER_PATCH, GITHUB_URL } from './constants';
import { FaGithub } from 'react-icons/fa';

interface Image {
  key: string;
  lastModified: string; // ISO 8601 date string
  size: number; // Bytes
  contentType: string; // e.g., image/jpeg
}

const App: React.FC = () => {
  const [images, setImages] = useState<Image[]>([]);
  const [displayedImages, setDisplayedImages] = useState<Image[]>([]);
  const [selectedImage, setSelectedImage] = useState<Image | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date()); // Default to today
  const [uniqueDates, setUniqueDates] = useState<Date[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [isFooterVisible, setIsFooterVisible] = useState<boolean>(true);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // S3-compatible API endpoint for bucket listing
  const bucketUrl: string = 'https://storage.algosol.ca/social-cleaner-posts-img/';
  const batchSize: number = 20; // Number of images per page
  const minFileSize: number = 10240; // 10KB in bytes

  // Normalize date to start of day in local timezone
  const normalizeDate = (date: Date): Date => {
    const normalized = new Date(date);
    normalized.setHours(0, 0, 0, 0);
    return normalized;
  };

  // Compare dates for equality (year, month, day in local timezone)
  const areDatesEqual = (date1: Date, date2: Date): boolean => {
    const d1 = normalizeDate(date1);
    const d2 = normalizeDate(date2);
    return (
      d1.getFullYear() === d2.getFullYear() &&
      d1.getMonth() === d2.getMonth() &&
      d1.getDate() === d2.getDate()
    );
  };

  // Calculate number of images for the selected date
  const getImageCount = (): number => {
    if (!selectedDate) return images.length;
    const selected = normalizeDate(selectedDate);
    return images.filter((image) => areDatesEqual(new Date(image.lastModified), selected)).length;
  };

  const fetchImages = useCallback(async () => {
    try {
      setLoading(true);
      const imageList: Image[] = [];
      let continuationToken: string | null = null;

      // Fetch objects with pagination
      do {
        // Construct URL with continuation token if present
        const url = continuationToken
          ? `${bucketUrl}?list-type=2&continuation-token=${encodeURIComponent(continuationToken)}`
          : `${bucketUrl}?list-type=2`;
        
        const response: Response = await fetch(url, {
          method: 'GET',
          headers: { 'Accept': 'application/xml' },
          mode: 'cors',
          credentials: 'omit',
        });

        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
        }

        const text: string = await response.text();

        // Check if response is HTML
        if (text.trim().startsWith('<!DOCTYPE html>') || text.includes('<html')) {
          throw new Error(
            'Received HTML instead of XML. The bucket URL may be incorrect or serving the MinIO browser UI. Contact the bucket owner to confirm the S3 API endpoint (e.g., https://storage.algosol.ca/s3/social-cleaner-posts-img/).'
          );
        }

        const parser: DOMParser = new DOMParser();
        const xml: Document = parser.parseFromString(text, 'application/xml');

        if (xml.querySelector('parsererror')) {
          throw new Error('Failed to parse XML response. Ensure the bucket returns a valid object listing.');
        }

        const imagePromises: Promise<Image | null>[] = Array.from(xml.querySelectorAll('Contents'))
          .map(async (node: Element) => {
            const key = node.querySelector('Key')?.textContent || '';
            if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(key)) return null;

            // Fetch metadata via HEAD request
            const headResponse = await fetch(`${bucketUrl}${encodeURIComponent(key)}`, {
              method: 'HEAD',
              mode: 'cors',
              credentials: 'omit',
            });
            if (!headResponse.ok) {
              console.warn(`Failed to fetch metadata for ${key}`);
              return null;
            }

            const size = parseInt(headResponse.headers.get('Content-Length') || '0', 10);
            if (size < minFileSize) return null; // Ignore images < 10KB

            return {
              key,
              lastModified: node.querySelector('LastModified')?.textContent || '',
              size,
              contentType: headResponse.headers.get('Content-Type') || 'unknown',
            };
          });

        const newImages = (await Promise.all(imagePromises))
          .filter((image): image is Image => image !== null);
        
        imageList.push(...newImages);

        // Get the next continuation token
        continuationToken = xml.querySelector('NextContinuationToken')?.textContent || null;
      } while (continuationToken);

      if (imageList.length === 0) {
        throw new Error('No images found in the bucket with size >= 10KB.');
      }

      // Sort images by lastModified (newest first)
      imageList.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

      // Compute unique dates (sorted descending) for calendar highlights
      const dates = Array.from(
        new Set(
          imageList.map((image) => {
            const date = normalizeDate(new Date(image.lastModified));
            return date.toISOString();
          })
        )
      )
        .map((dateStr) => new Date(dateStr))
        .sort((a, b) => b.getTime() - a.getTime());

      setImages(imageList);
      setUniqueDates(dates);

      // Filter for today's date by default
      const today = normalizeDate(new Date());
      const todayImages = imageList.filter((image) =>
        areDatesEqual(new Date(image.lastModified), today)
      );
      setDisplayedImages(todayImages.slice(0, batchSize));
      setHasMore(todayImages.length > batchSize);
      setLoading(false);
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error
          ? err.message.includes('cors') || err.message.includes('fetch')
            ? `${err.message}. Ensure the server is correctly configured to allow CORS for ${window.location.origin}.`
            : err.message
          : 'Unknown error';
      setError(errorMessage);
      setLoading(false);
    }
  }, [bucketUrl, batchSize]);

  // Initial fetch
  useEffect(() => {
    fetchImages();
  }, [fetchImages]);

  // Filter images by selected date and clear displayed images
  useEffect(() => {
    setDisplayedImages([]);
    setPage(1);
    if (!selectedDate) {
      setDisplayedImages(images.slice(0, batchSize));
      setHasMore(images.length > batchSize);
      return;
    }

    const selected = normalizeDate(selectedDate);
    const filteredImages = images.filter((image) =>
      areDatesEqual(new Date(image.lastModified), selected)
    );

    setDisplayedImages(filteredImages.slice(0, batchSize));
    setHasMore(filteredImages.length > batchSize);
  }, [selectedDate, images, batchSize]);

  // Load more images when scrolling
  const loadMoreImages = useCallback(() => {
    if (!hasMore || loading) return;

    setLoading(true);
    const nextPage = page + 1;
    const startIndex = page * batchSize;
    const endIndex = nextPage * batchSize;

    const imagesToDisplay = selectedDate
      ? images.filter((image) =>
          areDatesEqual(new Date(image.lastModified), normalizeDate(selectedDate))
        )
      : images;

    const newImages = imagesToDisplay.slice(startIndex, endIndex);

    setDisplayedImages((prev) => [...prev, ...newImages]);
    setPage(nextPage);
    setHasMore(endIndex < imagesToDisplay.length);
    setLoading(false);
  }, [hasMore, loading, images, page, batchSize, selectedDate]);

  // Intersection Observer for infinite scrolling
  useEffect(() => {
    if (!hasMore || loading) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMoreImages();
        }
      },
      { threshold: 0.1 }
    );

    if (sentinelRef.current) {
      observerRef.current.observe(sentinelRef.current);
    }

    return () => {
      if (sentinelRef.current && observerRef.current) {
        observerRef.current.unobserve(sentinelRef.current);
      }
    };
  }, [hasMore, loading, loadMoreImages]);

  // Handle scroll to toggle footer visibility
  useEffect(() => {
    const handleScroll = () => {
      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      setIsFooterVisible(scrollTop === 0);
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Handle image click to open modal
  const handleImageClick = (image: Image) => {
    console.log('Image clicked:', image);
    setSelectedImage(image);
  };

  // Close modal
  const handleCloseModal = () => {
    console.log('Closing modal');
    setSelectedImage(null);
  };

  // Navigate to previous image
  const handlePreviousImage = () => {
    if (!selectedImage) return;
    const currentImages = selectedDate
      ? images.filter((image) =>
          areDatesEqual(new Date(image.lastModified), normalizeDate(selectedDate))
        )
      : images;
    const currentIndex = currentImages.findIndex((image) => image.key === selectedImage.key);
    if (currentIndex > 0) {
      setSelectedImage(currentImages[currentIndex - 1]);
    }
  };

  // Navigate to next image
  const handleNextImage = () => {
    if (!selectedImage) return;
    const currentImages = selectedDate
      ? images.filter((image) =>
          areDatesEqual(new Date(image.lastModified), normalizeDate(selectedDate))
        )
      : images;
    const currentIndex = currentImages.findIndex((image) => image.key === selectedImage.key);
    if (currentIndex < currentImages.length - 1) {
      setSelectedImage(currentImages[currentIndex + 1]);
    }
  };

  // Check if previous/next images exist
  const hasPreviousImage = selectedImage
    ? (selectedDate
        ? images.filter((image) =>
            areDatesEqual(new Date(image.lastModified), normalizeDate(selectedDate))
          )
        : images
      ).findIndex((image) => image.key === selectedImage.key) > 0
    : false;
  const hasNextImage = selectedImage
    ? (selectedDate
        ? images.filter((image) =>
            areDatesEqual(new Date(image.lastModified), normalizeDate(selectedDate))
          )
        : images
      ).findIndex((image) => image.key === selectedImage.key) <
      (selectedDate
        ? images.filter((image) =>
            areDatesEqual(new Date(image.lastModified), normalizeDate(selectedDate))
          )
        : images
      ).length - 1
    : false;

  // Navigate to previous date
  const handlePreviousDate = () => {
    if (selectedDate) {
      setSelectedDate(new Date(selectedDate.getTime() - 24 * 60 * 60 * 1000));
    } else {
      setSelectedDate(new Date());
    }
  };

  // Navigate to next date
  const handleNextDate = () => {
    if (selectedDate) {
      setSelectedDate(new Date(selectedDate.getTime() + 24 * 60 * 60 * 1000));
    }
  };

  // Check if previous/next dates exist
  const hasPreviousDate = true;
  const hasNextDate = selectedDate ? !areDatesEqual(selectedDate, new Date()) : false;

  // Format selected date for display
  const formatSelectedDate = (date: Date | null): string => {
    if (!date) return 'All Dates';
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  };

  return (
    <div className="bg-gray-100 min-h-screen flex flex-col">
      <header className="bg-blue-600 text-white p-4 text-center">
        <h1 className="text-2xl font-bold">Image Preview Gallery</h1>
        <p className="mt-2">Images from social-cleaner-posts-img bucket</p>
      </header>
      <main className="container mx-auto p-4 flex-grow">
        <div className="mb-4 flex flex-col sm:flex-row items-center gap-4 bg-white p-4 rounded-lg shadow">
          <div className="flex items-center gap-2 relative group">
            <label htmlFor="date-picker" className="font-medium text-gray-700">
              Filter by Date:
            </label>
            <DatePicker
              id="date-picker"
              selected={selectedDate}
              onChange={(date: Date | null) => setSelectedDate(date)}
              className="border rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white shadow-sm"
              placeholderText="Select a date"
              dateFormat="yyyy-MM-dd"
              maxDate={new Date()}
              highlightDates={uniqueDates}
            />
            <div className="absolute hidden group-hover:block bg-gray-800 text-white text-xs rounded py-1 px-2 -top-10 left-1/2 transform -translate-x-1/2">
              Select a date to filter images
            </div>
          </div>
          <div className="flex gap-2 items-center">
            <button
              onClick={handlePreviousDate}
              disabled={!hasPreviousDate}
              className={`flex items-center px-4 py-2 rounded ${
                hasPreviousDate
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              } focus:outline-none focus:ring-2 focus:ring-blue-500`}
              aria-label="Previous date"
            >
              <svg
                className="w-4 h-4 mr-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
              </svg>
              Previous
            </button>
            <button
              onClick={handleNextDate}
              disabled={!hasNextDate}
              className={`flex items-center px-4 py-2 rounded ${
                hasNextDate
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-gray-300 text-gray-500 cursor-not-allowed'
              } focus:outline-none focus:ring-2 focus:ring-blue-500`}
              aria-label="Next date"
            >
              Next
              <svg
                className="w-4 h-4 ml-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            {selectedDate && (
              <button
                onClick={() => setSelectedDate(new Date())}
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500"
                aria-label="Clear date filter"
              >
                Clear
              </button>
            )}
          </div>
        </div>
        {selectedDate && (
          <div className="mb-4 text-center text-gray-700">
            Showing <span className="font-semibold">{getImageCount()}</span> images from:{' '}
            <span className="font-semibold">{formatSelectedDate(selectedDate)}</span>
          </div>
        )}
        {error && <div className="text-center text-red-600 mt-4">Error: {error}</div>}
        {displayedImages.length === 0 && !loading && !error && (
          <div className="text-center text-gray-600 mt-4">
            No images found for {formatSelectedDate(selectedDate)}.
          </div>
        )}
        <div className="gallery grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {displayedImages.map((image: Image) => (
            <div
              key={image.key}
              className="bg-white p-2 rounded shadow cursor-pointer"
              onClick={() => handleImageClick(image)}
            >
              <img
                src={`${bucketUrl}${encodeURIComponent(image.key)}`}
                alt={image.key}
                className="w-full h-48 object-cover rounded"
                loading="lazy"
                onError={(e: React.SyntheticEvent<HTMLImageElement>) =>
                  e.currentTarget.parentElement?.remove()
                }
              />
            </div>
          ))}
        </div>
        {loading && <div className="text-center text-gray-600 mt-4">Loading images...</div>}
        <div ref={sentinelRef} className="h-10" />
      </main>
      <footer
        className={`fixed bottom-0 left-0 right-0 bg-gray-800 text-white text-center p-4 z-10 transition-opacity duration-300 ${
          isFooterVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex flex-col items-center gap-1">
          <p className="text-sm font-bold">
            v{VERSION_NUMBER_MAJOR}.{VERSION_NUMBER_MINOR}.{VERSION_NUMBER_PATCH}
          </p>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center text-blue-400 hover:text-blue-300 no-underline text-sm"
            aria-label="Visit GitHub repository"
          >
            <FaGithub className="w-4 h-4 mr-1" />
            GitHub
          </a>
          <p className="text-sm mt-2">© 2025 Image Preview App</p>
        </div>
      </footer>
      {selectedImage && (
        <ImageModal
          imageUrl={`${bucketUrl}${encodeURIComponent(selectedImage.key)}`}
          alt={selectedImage.key}
          metadata={{
            filename: selectedImage.key,
            lastModified: selectedImage.lastModified,
            size: selectedImage.size,
            contentType: selectedImage.contentType,
          }}
          onClose={handleCloseModal}
          onPreviousImage={handlePreviousImage}
          onNextImage={handleNextImage}
          hasPreviousImage={hasPreviousImage}
          hasNextImage={hasNextImage}
        />
      )}
    </div>
  );
};

export default App;