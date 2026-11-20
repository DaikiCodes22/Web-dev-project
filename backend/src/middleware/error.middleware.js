const notFound = (req, res) => res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });

const errorHandler = (err, _req, res, _next) => {
  if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That record already exists (duplicate value)' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(422).json({ message: 'File is too large (max 10 MB)' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const message = status >= 500 && process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message;
  res.status(status).json({ message, ...(err.details ? { details: err.details } : {}) });
};

module.exports = { notFound, errorHandler };
