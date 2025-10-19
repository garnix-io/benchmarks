#!/usr/bin/env python3
"""
Simple HTTP server for serving the visualization dashboard locally.
This avoids CORS issues when loading JSON files from the browser.
"""

import http.server
import socketserver
import os
import sys
from pathlib import Path

def main():
    # Change to the visualizations directory
    viz_dir = Path("visualizations")
    if not viz_dir.exists():
        print("Error: visualizations directory not found!")
        print("Please run generate_visualizations.py first.")
        sys.exit(1)
    
    os.chdir(viz_dir)
    
    # Check if required files exist
    if not Path("dashboard.html").exists():
        print("Error: dashboard.html not found in visualizations directory!")
        sys.exit(1)
    
    if not Path("dashboard_data.json").exists():
        print("Error: dashboard_data.json not found!")
        print("Please run generate_visualizations.py first to generate the data.")
        sys.exit(1)
    
    # Start the server
    PORT = 8000
    Handler = http.server.SimpleHTTPRequestHandler
    
    try:
        with socketserver.TCPServer(("", PORT), Handler) as httpd:
            print(f"Serving dashboard at http://localhost:{PORT}/dashboard.html")
            print("Press Ctrl+C to stop the server")
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped")
    except OSError as e:
        if "Address already in use" in str(e):
            print(f"Port {PORT} is already in use. Trying port {PORT + 1}...")
            PORT += 1
            with socketserver.TCPServer(("", PORT), Handler) as httpd:
                print(f"Serving dashboard at http://localhost:{PORT}/dashboard.html")
                print("Press Ctrl+C to stop the server")
                httpd.serve_forever()
        else:
            raise

if __name__ == "__main__":
    main()