const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/**
 * Get repositories for the authenticated user
 */
exports.getRepositories = async (req, res) => {
  try {
    const userId = req.user.uid || req.user.firebase_uid || req.user.id;
    console.log('GitHub controller - Getting repositories for user ID:', userId);

    // Try multiple ways to find the user and their GitHub token
    let user = null;
    let tokenFound = false;
    
    // First try by firebase_uid
    const { data: userByFirebaseUid, error: firebaseUidError } = await supabase
      .from('users')
      .select('*')
      .eq('firebase_uid', userId)
      .single();
      
    if (userByFirebaseUid?.github_access_token) {
      console.log('Found token using firebase_uid');
      user = userByFirebaseUid;
      tokenFound = true;
    } else {
      console.log('Token not found using firebase_uid, trying id field');
      
      // Try by id field as fallback
      const { data: userById, error: idError } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single();
        
      if (userById?.github_access_token) {
        console.log('Found token using id field');
        user = userById;
        tokenFound = true;
      }
    }
    
    // Log detailed debug info
    console.log('GitHub controller - User lookup results:', { 
      userId, 
      foundByFirebaseUid: !!userByFirebaseUid, 
      foundById: !!user && !userByFirebaseUid,
      tokenFound: tokenFound
    });
    
    if (!tokenFound) {
      // Log all users in the database to help debug
      const { data: allUsers } = await supabase
        .from('users')
        .select('id, firebase_uid, github_username')
        .limit(10);
        
      console.log('Available users in database:', allUsers);
      
      return res.status(401).json({ 
        error: 'GitHub authentication required', 
        message: 'No GitHub access token found for your account. Please sign in with GitHub again.'
      });
    }

    let repositories = [];
    
    // Fetch repositories from GitHub API
    try {
      const response = await axios({
        method: 'get',
        url: 'https://api.github.com/user/repos',
        params: {
          sort: 'updated',
          per_page: 100
        },
        headers: {
          Authorization: `token ${user.github_access_token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });
      
      repositories = response.data;
      console.log(`Successfully fetched ${repositories.length} repositories from GitHub`);
      
    } catch (error) {
      console.error('Error fetching GitHub repositories:', error.message);
      
      // Check if it's an authentication error
      if (error.response && error.response.status === 401) {
        // Clear the invalid token
        await supabase
          .from('users')
          .update({ github_access_token: null })
          .eq('firebase_uid', userId);
          
        return res.status(401).json({ 
          error: 'GitHub authentication required', 
          message: 'Your GitHub token has expired or is invalid. Please reconnect your GitHub account.'
        });
      }
      
      return res.status(error.response?.status || 500).json({ 
        error: 'Failed to fetch repositories from GitHub',
        message: error.message
      });
    }
    
    // Return only the data we need
    const formattedRepos = repositories.map(repo => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      html_url: repo.html_url,
      description: repo.description,
      default_branch: repo.default_branch,
      visibility: repo.visibility,
      updated_at: repo.updated_at,
    }));

    res.status(200).json({ repositories: formattedRepos });
  } catch (error) {
    console.error('Get repositories error:', error);
    res.status(500).json({ error: 'Failed to fetch repositories' });
  }
};

/**
 * Get branches for a specific repository
 */
exports.getRepositoryBranches = async (req, res) => {
  try {
    const userId = req.user.uid || req.user.firebase_uid || req.user.id;
    const { owner, repo } = req.params;

    // Try multiple ways to find the user and their GitHub token
    let user = null;
    let tokenFound = false;
    
    // First try by firebase_uid
    const { data: userByFirebaseUid, error: firebaseUidError } = await supabase
      .from('users')
      .select('*')
      .eq('firebase_uid', userId)
      .single();
      
    if (userByFirebaseUid?.github_access_token) {
      console.log('Found token using firebase_uid');
      user = userByFirebaseUid;
      tokenFound = true;
    } else {
      console.log('Token not found using firebase_uid, trying id field');
      
      // Try by id field as fallback
      const { data: userById, error: idError } = await supabase
        .from('users')
        .select('*')
        .eq('id', userId)
        .single();
        
      if (userById?.github_access_token) {
        console.log('Found token using id field');
        user = userById;
        tokenFound = true;
      }
    }
    
    // Log detailed debug info
    console.log('GitHub controller (branches) - User lookup results:', { 
      userId, 
      foundByFirebaseUid: !!userByFirebaseUid, 
      foundById: !!user && !userByFirebaseUid,
      tokenFound: tokenFound
    });
    
    if (!tokenFound) {
      // Log all users in the database to help debug
      const { data: allUsers } = await supabase
        .from('users')
        .select('id, firebase_uid, github_username')
        .limit(10);
        
      console.log('Available users in database:', allUsers);
      
      return res.status(401).json({ 
        error: 'GitHub authentication required', 
        message: 'No GitHub access token found for your account. Please sign in with GitHub again.'
      });
    }

    // Fetch branches from GitHub API
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches`, {
      headers: {
        Authorization: `token ${user.github_access_token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('GitHub API error:', errorData);
      return res.status(response.status).json({ error: 'Failed to fetch branches from GitHub' });
    }

    const branches = await response.json();
    
    res.status(200).json({ branches });
  } catch (error) {
    console.error('Get repository branches error:', error);
    res.status(500).json({ error: 'Failed to fetch repository branches' });
  }
};

/**
 * Validate repository access
 */
exports.validateRepository = async (req, res) => {
  try {
    const userId = req.user.uid || req.user.id;
    const { repositoryUrl } = req.body;

    // Extract owner and repo from URL
    const urlPattern = /github\.com\/([^\/]+)\/([^\/]+)/;
    const match = repositoryUrl.match(urlPattern);
    
    if (!match) {
      return res.status(400).json({ error: 'Invalid GitHub repository URL' });
    }
    
    const [, owner, repo] = match;

    // Get user from database to retrieve GitHub access token
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('github_access_token')
      .eq('firebase_uid', userId)
      .single();
      
    console.log('GitHub controller (validate) - User lookup result:', { userId, userFound: !!user, hasToken: user?.github_access_token ? true : false });

    if (userError || !user || !user.github_access_token) {
      return res.status(401).json({ error: 'GitHub authentication required' });
    }

    // Check repository access
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `token ${user.github_access_token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      return res.status(403).json({ error: 'Repository not found or no access' });
    }

    const repoData = await response.json();
    
    res.status(200).json({ 
      valid: true, 
      repository: {
        id: repoData.id,
        name: repoData.name,
        full_name: repoData.full_name,
        default_branch: repoData.default_branch,
        visibility: repoData.visibility
      } 
    });
  } catch (error) {
    console.error('Validate repository error:', error);
    res.status(500).json({ error: 'Failed to validate repository' });
  }
};
