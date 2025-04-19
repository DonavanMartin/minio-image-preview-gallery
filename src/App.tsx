import { useState, useEffect, useRef, useCallback } from 'react';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import ImageModal from './ImageModal';
import { VERSION_NUMBER_MAJOR, VERSION_NUMBER_MINOR, VERSION_NUMBER_PATCH, GITHUB_URL } from './constants';
import { FaGithub } from 'react-icons/fa';
import pLimit from 'p-limit';

interface Image {
  key: string;
  lastModified: string; // ISO 8601 date string
  size: number; // Bytes
  contentType: string; // e.g., image/jpeg
}

interface ObjectInfo {
  key: string;
  lastModified: string; // ISO 8601 date string
}

const App: React.FC = () => {
  const [objects, setObjects] = useState<ObjectInfo[]>([]); // Raw objects from bucket
  const [images, setImages] = useState<Image[]>([]); // Images with metadata
  const [displayedImages, setDisplayedImages] = useState<Image[]>([]);
  const [selectedImage, setSelectedImage] = useState<Image | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date | null>(new Date());
  const [uniqueDates, setUniqueDates] = useState<Date[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [isFooterVisible, setIsFooterVisible] = useState<boolean>(true);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const metadataCache = useRef<Map<string, Image>>(new Map()); // Cache for metadata

  // S3-compatible API endpoint for bucket listing
  const bucketUrl: string = 'https://storage.algosol.ca/social-cleaner-posts-img/';
  const batchSize: number = 20; // Number of images per page
  const minFileSize: number = 10240; // 10KB in bytes
  const concurrentRequests: number = 5; // Max concurrent HEAD requests

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

  // Fetch object list (keys and lastModified) with pagination
  const fetchObjects = useCallback(async () => {
    try {
      setLoading(true);
      const objectList: ObjectInfo[] = [];
      let continuationToken: string | null = null;

      do {
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

        const objects = Array.from(xml.querySelectorAll('Contents')).map((node: Element) => ({
          key: node.querySelector('Key')?.textContent || '',
          lastModified: node.querySelector('LastModified')?.textContent || '',
        }));

        objectList.push(...objects);
        continuationToken = xml.querySelector('NextContinuationToken')?.textContent || null;
      } while (continuationToken);

      if (objectList.length === 0) {
        throw new Error('No objects found in the bucket.');
      }

      // Filter for image extensions and sort by lastModified (newest first)
      const filteredObjects = objectList
        .filter((obj) => /\.(jpg|jpeg|png|gif|webp)$/i.test(obj.key))
        .sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

      // Compute unique dates (sorted descending)
      const dates = Array.from(
        new Set(
          filteredObjects.map((obj) => {
            const date = normalizeDate(new Date(obj.lastModified));
            return date.toISOString();
          })
        )
      )
        .map((dateStr) => new Date(dateStr))
        .sort((a, b) => b.getTime() - a.getTime());

      setObjects(filteredObjects);
      setUniqueDates(dates);
      setLoading(false);
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error
          ? err.message.includes('cors') || err.message.includes('fetch')
            ? `${err.message}. Ensure the server is configured to allow CORS for ${window.location.origin}.`
            : err.message
          : 'Unknown error';
      setError(errorMessage);
      setLoading(false);
    }
  }, [bucketUrl]);

  // Fetch metadata for a batch of objects
  const fetchMetadata = useCallback(
    async (objectsToFetch: ObjectInfo[]): Promise<Image[]> => {
      const limit = pLimit(concurrentRequests);
      const imagePromises: Promise<Image | null>[] = objectsToFetch.map((obj) =>
        limit(async () => {
          // Check cache first
          const cached = metadataCache.current.get(obj.key);
          if (cached) return cached;

          try {
            const headResponse = await fetch(`${bucketUrl}${encodeURIComponent(obj.key)}`, {
              method: 'HEAD',
              mode: 'cors',
              credentials: 'omit',
            });
            if (!headResponse.ok) {
              console.warn(`Failed to fetch metadata for ${obj.key}`);
              return null;
            }

            const size = parseInt(headResponse.headers.get('Content-Length') || '0', 10);
            if (size < minFileSize) return null;

            const image: Image = {
              key: obj.key,
              lastModified: obj.lastModified,
              size,
              contentType: headResponse.headers.get('Content-Type') || 'unknown',
            };

            // Cache the metadata
            metadataCache.current.set(obj.key, image);
            return image;
          } catch (err) {
            console.warn(`Error fetching metadata for ${obj.key}:`, err);
            return null;
          }
        })
      );

      return (await Promise.all(imagePromises)).filter((image): image is Image => image !== null);
    },
    [bucketUrl, minFileSize]
  );

  // Initial fetch of objects
  useEffect(() => {
    fetchObjects();
  }, [fetchObjects]);

  // Filter images by selected date and fetch initial metadata
  useEffect(() => {
    setDisplayedImages([]);
    setImages([]);
    setPage(1);
    metadataCache.current.clear(); // Clear cache on date change

    const fetchInitialImages = async () => {
      try {
        setLoading(true);
        const objectsToDisplay = selectedDate
          ? objects.filter((obj) => areDatesEqual(new Date(obj.lastModified), normalizeDate(selectedDate)))
          : objects;

        const initialObjects = objectsToDisplay.slice(0, batchSize);
        const newImages = await fetchMetadata(initialObjects);

        setImages(newImages);
        setDisplayedImages(newImages);
        setHasMore(objectsToDisplay.length > batchSize);
      } catch (err) {
        setError('Failed to fetch initial image metadata.');
      } finally {
        setLoading(false);
      }
    };

    if (objects.length > 0) {
      fetchInitialImages();
    }
  }, [selectedDate, objects, batchSize, fetchMetadata]);

  // Load more images when scrolling
  const loadMoreImages = useCallback(async () => {
    if (!hasMore || loading) return;

    setLoading(true);
    const nextPage = page + 1;
    const startIndex = page * batchSize;
    const endIndex = nextPage * batchSize;

    const objectsToDisplay = selectedDate
      ? objects.filter((obj) => areDatesEqual(new Date(obj.lastModified), normalizeDate(selectedDate)))
      : objects;

    const nextObjects = objectsToDisplay.slice(startIndex, endIndex);
    const newImages = await fetchMetadata(nextObjects);

    setImages((prev) => [...prev, ...newImages]);
    setDisplayedImages((prev) => [...prev, ...newImages]);
    setPage(nextPage);
    setHasMore(endIndex < objectsToDisplay.length);
    setLoading(false);
  }, [hasMore, loading, objects, page, batchSize, selectedDate, fetchMetadata]);

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
                viewBox="0 24 24"
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
                viewBox="0 24 24"
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
          {loading && (
            <>
              {Array.from({ length: batchSize }).map((_, index) => (
                <div key={`placeholder-${index}`} className="bg-white p-2 rounded shadow">
                  <div className="w-full h-48 bg-gray-200 animate-pulse rounded"></div>
                </div>
              ))}
            </>
          )}
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