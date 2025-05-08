# Use Node.js LTS base image
FROM node:18

# Set working directory
WORKDIR /app

# Copy app files
COPY . .

# Install dependencies
RUN npm install

# Set environment port
ENV PORT=8080

# Start the server
CMD ["node", "index.js"]
