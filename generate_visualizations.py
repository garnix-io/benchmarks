#!/usr/bin/env python3
import json
import os
import glob
from collections import defaultdict
from pathlib import Path

def parse_data():
    """Parse all JSON files and organize by repo and platform"""
    data_dir = Path("data")
    results = defaultdict(lambda: defaultdict(list))
    
    for org_dir in data_dir.iterdir():
        if not org_dir.is_dir():
            continue
            
        for repo_dir in org_dir.iterdir():
            if not repo_dir.is_dir():
                continue
                
            repo_key = f"{org_dir.name}/{repo_dir.name}"
            
            for platform_dir in repo_dir.iterdir():
                if not platform_dir.is_dir():
                    continue
                    
                platform_name = platform_dir.name
                
                # Get all JSON files and sort by filename prefix
                json_files = sorted(platform_dir.glob("*.json"))
                
                for json_file in json_files:
                    try:
                        with open(json_file, 'r') as f:
                            data = json.load(f)
                        
                        # Extract commit hash from filename
                        filename = json_file.name
                        parts = filename.split('_', 1)
                        commit_index = int(parts[0])
                        commit_hash = parts[1].replace('.json', '') if len(parts) > 1 else 'unknown'
                        
                        # Convert time from ms to minutes for better readability
                        time_minutes = data.get('time', 0) / (1000 * 60)
                        
                        results[repo_key][platform_name].append({
                            'commit_index': commit_index,
                            'commit_hash': commit_hash,
                            'time_minutes': time_minutes,
                            'branch_name': data.get('branchName', 'main')
                        })
                        
                    except (json.JSONDecodeError, ValueError) as e:
                        print(f"Error parsing {json_file}: {e}")
                        continue
                
                # Sort by commit index
                results[repo_key][platform_name].sort(key=lambda x: x['commit_index'])
    
    return dict(results)

def get_platform_color(platform):
    """Get consistent colors for each platform"""
    colors = {
        'garnix': '#4CAF50',
        'github-actions-parallel': '#2196F3',
        'github-actions-serial': '#FF9800',
        'github-actions-cachix-parallel': '#9C27B0',
        'github-actions-cachix-serial': '#F44336'
    }
    return colors.get(platform, '#607D8B')

def generate_chart_data(repo_name, repo_data):
    """Generate chart data structure for a repository"""
    
    # Prepare datasets for Chart.js
    datasets = []
    
    for platform, commits in repo_data.items():
        if not commits:
            continue
            
        dataset = {
            'label': platform,
            'data': [{'x': commit['commit_index'], 'y': commit['time_minutes'], 
                     'commit_hash': commit['commit_hash'], 
                     'branch_name': commit['branch_name']} for commit in commits],
            'borderColor': get_platform_color(platform),
            'backgroundColor': get_platform_color(platform) + '20',
            'fill': False,
            'tension': 0.1,
            'pointRadius': 4,
            'pointHoverRadius': 6
        }
        datasets.append(dataset)
    
    return datasets

def generate_summary_data(all_data):
    """Calculate summary statistics with equal repository weighting"""
    from collections import defaultdict
    
    platform_repo_averages = defaultdict(list)
    
    # Calculate average for each platform within each repo
    for repo_name, repo_data in all_data.items():
        for platform, commits in repo_data.items():
            if commits:
                repo_avg = sum(commit['time_minutes'] for commit in commits) / len(commits)
                platform_repo_averages[platform].append(repo_avg)
    
    # Average the repo averages (equal weighting per repo)
    platform_global_averages = {}
    for platform, repo_avgs in platform_repo_averages.items():
        if repo_avgs:
            platform_global_averages[platform] = sum(repo_avgs) / len(repo_avgs)
    
    # Find fastest platform
    if not platform_global_averages:
        return []
    
    fastest_time = min(platform_global_averages.values())
    
    # Calculate slowdown ratios
    summary_data = []
    for platform, avg_time in platform_global_averages.items():
        slowdown_factor = avg_time / fastest_time
        summary_data.append({
            'platform': platform,
            'average_time': avg_time,
            'slowdown_factor': slowdown_factor,
            'repo_count': len(platform_repo_averages[platform])
        })
    
    return sorted(summary_data, key=lambda x: x['slowdown_factor'])

def generate_dashboard_data(all_data):
    """Generate JSON data structure for the dashboard"""
    
    # Prepare tab data and chart datasets
    repo_names = []
    all_datasets = []
    
    for repo_name, repo_data in sorted(all_data.items()):
        # Prepare datasets for Chart.js
        datasets = []
        
        for platform, commits in repo_data.items():
            if not commits:
                continue
                
            dataset = {
                'label': platform,
                'data': [{'x': commit['commit_index'], 'y': commit['time_minutes'], 
                         'commit_hash': commit['commit_hash'], 
                         'branch_name': commit['branch_name']} for commit in commits],
                'borderColor': get_platform_color(platform),
                'backgroundColor': get_platform_color(platform) + '20',
                'fill': False,
                'tension': 0.1,
                'pointRadius': 4,
                'pointHoverRadius': 6
            }
            datasets.append(dataset)
        
        repo_names.append(repo_name)
        all_datasets.append(datasets)
    
    # Generate summary data
    summary_data = generate_summary_data(all_data)
    
    return {
        'repo_names': repo_names,
        'datasets': all_datasets,
        'summary': summary_data
    }

def main():
    """Main function to process data and generate JSON output"""
    print("Parsing CI data...")
    all_data = parse_data()
    
    # Create output directory
    output_dir = Path("visualizations")
    output_dir.mkdir(exist_ok=True)
    
    print(f"Found data for {len(all_data)} repositories")
    
    # Generate dashboard data as JSON
    print("Generating dashboard data...")
    dashboard_data = generate_dashboard_data(all_data)
    
    # Write JSON data file
    json_file = output_dir / "dashboard_data.json"
    with open(json_file, 'w') as f:
        json.dump(dashboard_data, f, indent=2)
    
    print(f"Generated dashboard data JSON with {len(all_data)} repositories in {output_dir}/")
    print(f"JSON data written to: {json_file.resolve()}")
    print()
    print("To view the dashboard:")
    print("1. Run: python serve.py")
    print("2. Open http://localhost:8000/dashboard.html in your browser")
    print()
    print("(The server is needed to avoid CORS issues when loading JSON files locally)")

if __name__ == "__main__":
    main()