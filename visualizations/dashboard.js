// Global variables
let repoNames = [];
let allDatasets = [];
let summaryDetailedData = {};
let enabledRepos = new Set();
let includeFirstCommitSummary = false;  // Default to exclude first commit
let chart = null;
let summaryChart = null;
let currentTab = 0;
let allPlatforms = [];
let platformColors = {};

// Generate colors for platforms dynamically
function generatePlatformColors(platforms) {
    const colors = [
        '#4CAF50', '#2196F3', '#FF9800', '#9C27B0', '#F44336',
        '#607D8B', '#795548', '#FF5722', '#673AB7', '#3F51B5',
        '#009688', '#8BC34A', '#CDDC39', '#FFC107', '#FF9800'
    ];

    const colorMap = {};
    platforms.forEach((platform, index) => {
        colorMap[platform] = colors[index % colors.length];
    });

    return colorMap;
}

function getPlatformColor(platform) {
    return platformColors[platform] || '#607D8B';
}

// Generate human-readable platform names
function getPlatformDisplayName(platform) {
    const nameMap = {
        'garnix': 'Garnix',
        'github-actions-parallel': 'GitHub Actions (Parallel)',
        'github-actions-serial': 'GitHub Actions (Serial)',
        'github-actions-cachix-parallel': 'GitHub Actions + Cachix (Parallel)',
        'github-actions-cachix-serial': 'GitHub Actions + Cachix (Serial)',
        'github-actions-magic-nix-cache-parallel': 'GitHub Actions + Magic Nix Cache (Parallel)',
        'nixbuild-net': 'nixbuild.net'
    };

    return nameMap[platform] || platform.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

// Load data from JSON file
async function loadData() {
    try {
        const response = await fetch('dashboard_data.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();

        // Process the data structure
        repoNames = data.repo_names;
        allDatasets = data.datasets;
        summaryDetailedData = data.summary_detailed_data || {};

        // Initialize all repos as enabled
        enabledRepos = new Set(repoNames);

        // Extract all unique platforms from the datasets
        const platformSet = new Set();
        allDatasets.forEach(repoDatasets => {
            repoDatasets.forEach(dataset => {
                platformSet.add(dataset.label);
            });
        });
        allPlatforms = Array.from(platformSet).sort();

        // Generate colors for all platforms
        platformColors = generatePlatformColors(allPlatforms);

        // Update dataset colors to use dynamically generated colors
        updateDatasetColors();

        // Hide loading, show dashboard
        document.getElementById('loading').style.display = 'none';
        document.getElementById('dashboard').style.display = 'block';

        // Initialize the dashboard
        initializeDashboard();

    } catch (error) {
        console.error('Error loading data:', error);
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'block';
    }
}

function calculateSummaryData() {
    if (Object.keys(summaryDetailedData).length === 0 || enabledRepos.size === 0) {
        return [];
    }

    const enabledReposArray = Array.from(enabledRepos);
    const platformSlowdownFactors = {};
    
    console.log("=== Summary Calculation Debug ===");
    console.log("includeFirstCommitSummary:", includeFirstCommitSummary);
    console.log("enabledRepos:", Array.from(enabledRepos));

    // For each enabled repository, calculate slowdown factors
    for (const repo of enabledReposArray) {
        const repoTimes = {};
        
        console.log(`\n--- Repository: ${repo} ---`);

        // Get filtered times for this repo across all platforms
        for (const [platform, repoData] of Object.entries(summaryDetailedData)) {
            if (repoData[repo]) {
                // Filter commits based on includeFirstCommitSummary setting
                const filteredCommits = repoData[repo].filter(commit => {
                    if (commit.commit_index === 0) {
                        return includeFirstCommitSummary;
                    } else {
                        return true; // Always include non-first commits
                    }
                });

                if (filteredCommits.length > 0) {
                    // Calculate average for this repo/platform combination
                    const avgTime = filteredCommits.reduce((sum, commit) => sum + commit.time_minutes, 0) / filteredCommits.length;
                    repoTimes[platform] = avgTime;
                    console.log(`${platform}: ${avgTime.toFixed(2)} minutes (${filteredCommits.length} commits)`);
                }
            }
        }

        // Only proceed if we have data for this repo
        if (Object.keys(repoTimes).length === 0) {
            continue;
        }

        // Find fastest platform for this repo
        const fastestTimeForRepo = Math.min(...Object.values(repoTimes));
        const fastestPlatform = Object.entries(repoTimes).find(([p, t]) => t === fastestTimeForRepo)[0];
        
        console.log(`Fastest for ${repo}: ${fastestPlatform} (${fastestTimeForRepo.toFixed(2)} minutes)`);

        // Calculate slowdown factors for this repo
        for (const [platform, time] of Object.entries(repoTimes)) {
            if (!platformSlowdownFactors[platform]) {
                platformSlowdownFactors[platform] = [];
            }
            const slowdownFactor = time / fastestTimeForRepo;
            platformSlowdownFactors[platform].push(slowdownFactor);
            console.log(`${platform}: ${slowdownFactor.toFixed(3)}x slowdown`);
        }
    }

    // Average the slowdown factors across repositories
    const summaryData = [];
    console.log("\n--- Final Averages ---");
    for (const [platform, slowdownFactors] of Object.entries(platformSlowdownFactors)) {
        if (slowdownFactors.length > 0) {
            const avgSlowdownFactor = slowdownFactors.reduce((a, b) => a + b, 0) / slowdownFactors.length;
            summaryData.push({
                platform: platform,
                slowdown_factor: avgSlowdownFactor,
                repo_count: slowdownFactors.length
            });
            console.log(`${platform}: ${avgSlowdownFactor.toFixed(3)}x average slowdown (${slowdownFactors.map(f => f.toFixed(2)).join(', ')})`);
        }
    }

    return summaryData.sort((a, b) => a.slowdown_factor - b.slowdown_factor);
}

function createSummaryChart() {
    if (summaryChart) {
        summaryChart.destroy();
    }

    const summaryData = calculateSummaryData();

    if (summaryData.length === 0) {
        return;
    }

    const summaryCtx = document.getElementById('summaryChart').getContext('2d');

    summaryChart = new Chart(summaryCtx, {
        type: 'bar',
        data: {
            labels: summaryData.map(d => getPlatformDisplayName(d.platform)),
            datasets: [{
                label: 'Slowdown Factor vs Fastest CI',
                data: summaryData.map(d => d.slowdown_factor),
                backgroundColor: summaryData.map(d => getPlatformColor(d.platform)),
                borderColor: summaryData.map(d => getPlatformColor(d.platform)),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: {
                    display: true,
                    text: `CI Performance Summary: Relative Slowdown Comparison [lower is better] (${enabledRepos.size}/${repoNames.length} repos${includeFirstCommitSummary ? ', incl. first commits' : ''})`,
                    font: { size: 16 }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const data = summaryData[context.dataIndex];
                            return [
                                `Average slowdown factor: ${data.slowdown_factor.toFixed(2)}x slower`,
                                `Repositories tested: ${data.repo_count}/${enabledRepos.size}`
                            ];
                        }
                    }
                },
                legend: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Slowdown Factor (vs Fastest CI)'
                    },
                    ticks: {
                        callback: function(value) {
                            return value.toFixed(1) + 'x';
                        }
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: 'CI Platform'
                    }
                }
            }
        }
    });
}

function createRepoCheckboxes() {
    const container = document.getElementById('repoCheckboxes');
    container.innerHTML = '';

    repoNames.forEach(repoName => {
        const label = document.createElement('label');
        label.className = 'filter-checkbox';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.onchange = () => updateRepoFilter(repoName, checkbox.checked);

        const span = document.createElement('span');
        span.className = 'checkmark';

        const text = document.createTextNode(repoName);

        label.appendChild(checkbox);
        label.appendChild(span);
        label.appendChild(text);
        container.appendChild(label);
    });
}

function updateRepoFilter(repoName, enabled) {
    if (enabled) {
        enabledRepos.add(repoName);
    } else {
        enabledRepos.delete(repoName);
    }

    // Recreate summary chart with new filter
    createSummaryChart();
}

function updateSummaryFirstCommitFilter() {
    includeFirstCommitSummary = document.getElementById('includeFirstCommitSummary').checked;
    createSummaryChart();
}

function initializeDashboard() {
    // Create repository checkboxes
    createRepoCheckboxes();

    // Create summary chart
    createSummaryChart();

    // Create tab buttons
    const tabsContainer = document.getElementById('tabs');
    tabsContainer.innerHTML = '';

    repoNames.forEach((repoName, index) => {
        const button = document.createElement('button');
        button.className = `tab${index === 0 ? ' active' : ''}`;
        button.textContent = repoName;
        button.onclick = () => showTab(index);
        tabsContainer.appendChild(button);
    });

    // Create platform legend
    createPlatformLegend();

    // Initialize with first tab
    showTab(0);
}

function createPlatformLegend() {
    const platformsContainer = document.getElementById('platforms');
    platformsContainer.innerHTML = '';

    allPlatforms.forEach(platform => {
        const tag = document.createElement('div');
        tag.className = 'platform-tag';
        tag.style.backgroundColor = getPlatformColor(platform);
        tag.textContent = getPlatformDisplayName(platform);
        platformsContainer.appendChild(tag);
    });
}

function updateDatasetColors() {
    // Update all datasets to use dynamically generated colors
    allDatasets.forEach(repoDatasets => {
        repoDatasets.forEach(dataset => {
            const color = getPlatformColor(dataset.label);
            dataset.borderColor = color;
            dataset.backgroundColor = color + '20'; // Add transparency
        });
    });
}

// Initialize Chart.js
const ctx = document.getElementById('performanceChart').getContext('2d');

function filterData(datasets) {
    const includeFirst = document.getElementById('includeFirst').checked;
    const includeOthers = document.getElementById('includeOthers').checked;

    return datasets.map(dataset => {
        const filteredData = dataset.data.filter(point => {
            if (point.x === 0) {
                return includeFirst;
            } else {
                return includeOthers;
            }
        });

        return {
            ...dataset,
            data: filteredData
        };
    });
}

function calculateStats(datasets) {
    // First, collect all commit indices that exist across all platforms
    const allCommitIndices = new Set();
    datasets.forEach(dataset => {
        dataset.data.forEach(point => allCommitIndices.add(point.x));
    });
    const sortedIndices = Array.from(allCommitIndices).sort((a, b) => a - b);

    // Check if any platform is missing data
    let hasMissingData = false;
    datasets.forEach(dataset => {
        const platformIndices = new Set(dataset.data.map(d => d.x));
        if (platformIndices.size !== sortedIndices.length) {
            hasMissingData = true;
        }
    });

    const stats = {};

    if (!hasMissingData) {
        // No missing data - calculate normally
        datasets.forEach(dataset => {
            const times = dataset.data.map(d => d.y);
            if (times.length > 0) {
                stats[dataset.label] = {
                    avg: times.reduce((a, b) => a + b, 0) / times.length,
                    min: Math.min(...times),
                    max: Math.max(...times),
                    count: times.length,
                    isProjected: false
                };
            }
        });
    } else {
        // Missing data - use projection method

        // Calculate speed factors for each platform relative to others
        const platformSpeedFactors = {};

        datasets.forEach(dataset => {
            const platformData = new Map(dataset.data.map(d => [d.x, d.y]));
            let totalSpeedFactor = 0;
            let comparisons = 0;

            // Compare with other platforms for overlapping commits
            datasets.forEach(otherDataset => {
                if (dataset.label === otherDataset.label) return;

                const otherData = new Map(otherDataset.data.map(d => [d.x, d.y]));

                // Find overlapping commits
                for (const [commitIndex, time] of platformData) {
                    if (otherData.has(commitIndex)) {
                        const otherTime = otherData.get(commitIndex);
                        if (otherTime > 0) {
                            const ratio = time / otherTime;
                            totalSpeedFactor += ratio;
                            comparisons++;
                        }
                    }
                }
            });

            if (comparisons > 0) {
                platformSpeedFactors[dataset.label] = totalSpeedFactor / comparisons;
            } else {
                platformSpeedFactors[dataset.label] = 1.0; // fallback
            }
        });

        // Calculate projected averages
        datasets.forEach(dataset => {
            const platformData = new Map(dataset.data.map(d => [d.x, d.y]));
            const actualTimes = dataset.data.map(d => d.y);

            if (actualTimes.length === 0) return;

            const speedFactor = platformSpeedFactors[dataset.label];
            let projectedSum = 0;
            let totalCount = 0;
            let missingCount = 0;

            // Process all possible commits (both actual and missing)
            sortedIndices.forEach(commitIndex => {
                if (platformData.has(commitIndex)) {
                    // Use actual value
                    projectedSum += platformData.get(commitIndex);
                    totalCount++;
                } else {
                    // Missing data point - project from other platforms
                    let projectedValue = 0;
                    let sourceCount = 0;

                    datasets.forEach(otherDataset => {
                        if (dataset.label === otherDataset.label) return;
                        const otherData = new Map(otherDataset.data.map(d => [d.x, d.y]));

                        if (otherData.has(commitIndex)) {
                            projectedValue += otherData.get(commitIndex);
                            sourceCount++;
                        }
                    });

                    if (sourceCount > 0) {
                        // Average other platforms' times and apply speed factor
                        const avgOtherTime = projectedValue / sourceCount;
                        projectedSum += avgOtherTime * speedFactor;
                        totalCount++;
                        missingCount++;
                    }
                }
            });

            const actualAvg = actualTimes.length > 0 ? actualTimes.reduce((a, b) => a + b, 0) / actualTimes.length : 0;
            const projectedAvg = totalCount > 0 ? projectedSum / totalCount : 0;

            stats[dataset.label] = {
                avg: projectedAvg,
                actualAvg: actualAvg,
                min: Math.min(...actualTimes),
                max: Math.max(...actualTimes),
                count: actualTimes.length,
                totalCount: totalCount,
                missingCount: missingCount,
                isProjected: missingCount > 0,
                speedFactor: speedFactor
            };
        });
    }

    return stats;
}

function createChart(datasets, repoName) {
    if (chart) {
        chart.destroy();
    }

    const filteredDatasets = filterData(datasets);

    chart = new Chart(ctx, {
        type: 'line',
        data: { datasets: filteredDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                title: {
                    display: true,
                    text: `CI Build Times Over Time - ${repoName}`,
                    font: { size: 18 }
                },
                tooltip: {
                    callbacks: {
                        title: function(context) {
                            const point = context[0];
                            const commit = point.raw.commit_hash.substring(0, 8);
                            return `Commit #${point.parsed.x}: ${commit}`;
                        },
                        label: function(context) {
                            const time = context.parsed.y.toFixed(1);
                            const branch = context.raw.branch_name || 'main';
                            return `${context.dataset.label}: ${time} minutes (branch: ${branch})`;
                        }
                    }
                },
                legend: {
                    position: 'top'
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    position: 'bottom',
                    title: {
                        display: true,
                        text: 'Commit Sequence'
                    },
                    grid: {
                        display: true,
                        color: '#e0e0e0'
                    },
                    ticks: {
                        stepSize: 1
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: 'Build Time (minutes)'
                    },
                    beginAtZero: true,
                    grid: {
                        display: true,
                        color: '#e0e0e0'
                    }
                }
            }
        }
    });
}

function updateStats(datasets) {
    const stats = calculateStats(datasets);
    const statsContainer = document.getElementById('stats');
    statsContainer.innerHTML = '';

    Object.entries(stats).forEach(([platform, stat]) => {
        const color = allDatasets[currentTab].find(d => d.label === platform)?.borderColor || '#666';
        const asterisk = stat.isProjected ? '*' : '';
        const tooltip = stat.isProjected
            ? `title="Projected average: ${stat.avg.toFixed(1)}m (actual: ${stat.actualAvg.toFixed(1)}m from ${stat.count} commits, ${stat.missingCount} projected using ${stat.speedFactor.toFixed(2)}x speed factor)"`
            : '';

        statsContainer.innerHTML += `
            <div class="stat-card" ${tooltip}>
                <div class="stat-number" style="color: ${color}">${stat.avg.toFixed(1)}m${asterisk}</div>
                <div class="stat-label">${platform}<br>Average Time (${stat.count}/${stat.totalCount || stat.count} commits)</div>
            </div>
        `;
    });
}

function updateChart() {
    if (currentTab >= 0) {
        const filteredDatasets = filterData(allDatasets[currentTab]);

        // Update chart data
        chart.data.datasets = filteredDatasets;
        chart.update();

        // Update statistics
        updateStats(filteredDatasets);
    }
}

function showTab(tabIndex) {
    // Update tab buttons
    document.querySelectorAll('.tab').forEach((tab, index) => {
        tab.classList.toggle('active', index === tabIndex);
    });

    currentTab = tabIndex;

    // Update chart and stats with current filters
    createChart(allDatasets[tabIndex], repoNames[tabIndex]);
    const filteredDatasets = filterData(allDatasets[tabIndex]);
    updateStats(filteredDatasets);
}

// Load data when page loads
loadData();
